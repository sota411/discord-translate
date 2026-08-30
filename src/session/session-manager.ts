import { randomUUID } from "node:crypto";

import type { TranslationTerm } from "../config/translation-terms.js";
import { ApplicationError } from "../domain/application-error.js";
import type { Language, LanguagePair } from "../domain/language-pair.js";
import type {
  CaptionFailurePolicy,
  PlaybackMode,
} from "./session-settings.js";

export type SessionState =
  | "AUTHORIZING"
  | "CONNECTING"
  | "ACTIVE"
  | "FAILED"
  | "STOPPING";

export type SessionDescriptor = {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  textChannelId: string;
  textChannelName: string;
  startedByUserId: string;
  pair: LanguagePair;
  state: SessionState;
  startedAt: Date;
  participantIds: readonly string[];
  playbackMode: PlaybackMode;
  ttsSpeed: number;
  audioEnabled: boolean;
  captionFailurePolicy: CaptionFailurePolicy;
  captionThreadId?: string;
};

export type StartSessionInput = Omit<
  SessionDescriptor,
  "sessionId" | "state" | "startedAt" | "captionThreadId"
> & {
  requiredSttStreams: number;
  translationTerms: readonly TranslationTerm[];
  speakerLanguageHints: ReadonlyMap<string, Language>;
};

export type UsageGate = {
  assertCanStart(input: {
    guildId: string;
    userIds: readonly string[];
    at: Date;
  }): Promise<void>;
};

export type CapacityGate = {
  assertCanStart(input: {
    sttStreams: number;
    ttsStreams: number;
    at: Date;
  }): Promise<void>;
};

export type SessionRuntime = {
  readonly captionThreadId?: string;
  updateParticipants(participantIds: readonly string[]): Promise<void>;
  setPlaybackMode(mode: PlaybackMode): Promise<void>;
  setTtsSpeed(speed: number): Promise<void>;
  setAudioEnabled(enabled: boolean): Promise<void>;
  setCaptionFailurePolicy(policy: CaptionFailurePolicy): Promise<void>;
  stop(reason: string): Promise<void>;
};

export type TranslationSessionDriver = {
  start(
    session: Readonly<SessionDescriptor>,
    participantIds: readonly string[],
    signal: AbortSignal,
    translationTerms: readonly TranslationTerm[],
    speakerLanguageHints: ReadonlyMap<string, Language>,
  ): Promise<SessionRuntime>;
};

type ManagedSession = SessionDescriptor & {
  runtime?: SessionRuntime;
  translationTerms: readonly TranslationTerm[];
  speakerLanguageHints: ReadonlyMap<string, Language>;
  participantRevision: number;
  startController: AbortController;
};

type SessionManagerDependencies = {
  driver: TranslationSessionDriver;
  usageGate: UsageGate;
  capacityGate: CapacityGate;
  onSessionStopped?: () => Promise<void>;
  now?: () => Date;
  createId?: () => string;
};

export class SessionManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #driver: TranslationSessionDriver;
  readonly #usageGate: UsageGate;
  readonly #capacityGate: CapacityGate;
  readonly #onSessionStopped: () => Promise<void>;
  readonly #now: () => Date;
  readonly #createId: () => string;

  public constructor(dependencies: SessionManagerDependencies) {
    this.#driver = dependencies.driver;
    this.#usageGate = dependencies.usageGate;
    this.#capacityGate = dependencies.capacityGate;
    this.#onSessionStopped = dependencies.onSessionStopped ?? (() => Promise.resolve());
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  public get(guildId: string): Readonly<SessionDescriptor> | undefined {
    return this.#sessions.get(guildId);
  }

  public async start(input: StartSessionInput): Promise<Readonly<SessionDescriptor>> {
    if (this.#sessions.has(input.guildId)) {
      throw new ApplicationError(
        "SESSION_ALREADY_ACTIVE",
        "このサーバーでは翻訳セッションを開始中、または実行中です。",
      );
    }

    const {
      requiredSttStreams,
      translationTerms,
      speakerLanguageHints,
      ...descriptor
    } = input;
    const startedAt = this.#now();
    const session: ManagedSession = {
      ...descriptor,
      participantIds: [...descriptor.participantIds],
      sessionId: this.#createId(),
      state: "AUTHORIZING",
      startedAt,
      translationTerms: translationTerms.map((term) => ({ ...term })),
      speakerLanguageHints: new Map(speakerLanguageHints),
      participantRevision: 0,
      startController: new AbortController(),
    };
    this.#sessions.set(input.guildId, session);

    try {
      await this.#usageGate.assertCanStart({
        guildId: session.guildId,
        userIds: session.participantIds,
        at: startedAt,
      });
      this.#assertCurrent(session);
      await this.#capacityGate.assertCanStart({
        sttStreams: requiredSttStreams,
        ttsStreams: 1,
        at: this.#now(),
      });
      this.#assertCurrent(session);
      session.state = "CONNECTING";
      session.runtime = await this.#driver.start(
        session,
        session.participantIds,
        session.startController.signal,
        session.translationTerms,
        session.speakerLanguageHints,
      );
      if (session.runtime.captionThreadId) {
        session.captionThreadId = session.runtime.captionThreadId;
      }
      this.#assertCurrent(session);
      session.state = "ACTIVE";
      return session;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (session.runtime) {
        try {
          await session.runtime.stop("START_ABORTED");
        } catch (caught) {
          cleanupErrors.push(caught);
        }
        try {
          await this.#onSessionStopped();
        } catch (caught) {
          cleanupErrors.push(caught);
        }
      }
      session.state = "FAILED";
      if (this.#sessions.get(session.guildId) === session) {
        this.#sessions.delete(session.guildId);
      }
      if (error instanceof ApplicationError && cleanupErrors.length === 0) {
        throw error;
      }
      throw new ApplicationError(
        "SESSION_START_FAILED",
        "翻訳セッションを開始できませんでした。時間を置いて再実行してください。",
        {
          cause: cleanupErrors.length > 0
            ? new AggregateError(cleanupErrors, "開始失敗後の停止処理に失敗しました")
            : error,
        },
      );
    }
  }

  public async updateParticipants(
    guildId: string,
    participantIds: readonly string[],
  ): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (session?.state !== "ACTIVE" || !session.runtime) {
      return;
    }
    const revision = ++session.participantRevision;
    const currentParticipantIds = new Set(session.participantIds);
    const addedUserIds = participantIds.filter(
      (participantId) => !currentParticipantIds.has(participantId),
    );
    if (addedUserIds.length > 0) {
      await this.#usageGate.assertCanStart({
        guildId,
        userIds: addedUserIds,
        at: this.#now(),
      });
    }
    const activeSession = this.#sessions.get(guildId);
    if (
      activeSession?.state !== "ACTIVE" ||
      activeSession !== session ||
      activeSession.participantRevision !== revision
    ) {
      return;
    }
    await session.runtime.updateParticipants(participantIds);
    if (session.participantRevision === revision) {
      session.participantIds = [...participantIds];
    }
  }

  public async setPlaybackMode(guildId: string, mode: PlaybackMode): Promise<void> {
    const session = this.#requireActiveRuntime(guildId);
    await session.runtime.setPlaybackMode(mode);
    session.playbackMode = mode;
  }

  public async setTtsSpeed(guildId: string, speed: number): Promise<void> {
    const session = this.#requireActiveRuntime(guildId);
    await session.runtime.setTtsSpeed(speed);
    session.ttsSpeed = speed;
  }

  public async setAudioEnabled(guildId: string, enabled: boolean): Promise<void> {
    const session = this.#requireActiveRuntime(guildId);
    await session.runtime.setAudioEnabled(enabled);
    session.audioEnabled = enabled;
  }

  public async setCaptionFailurePolicy(
    guildId: string,
    policy: CaptionFailurePolicy,
  ): Promise<void> {
    const session = this.#requireActiveRuntime(guildId);
    await session.runtime.setCaptionFailurePolicy(policy);
    session.captionFailurePolicy = policy;
  }

  public async stop(guildId: string, reason: string): Promise<boolean> {
    const session = this.#sessions.get(guildId);
    if (!session) {
      return false;
    }
    session.state = "STOPPING";
    session.startController.abort(new ApplicationError(
      "SESSION_START_FAILED",
      "開始処理中に翻訳セッションが停止されました。",
    ));
    const errors: unknown[] = [];
    try {
      await session.runtime?.stop(reason);
    } catch (error) {
      errors.push(error);
    } finally {
      if (session.runtime && this.#sessions.get(guildId) === session) {
        this.#sessions.delete(guildId);
      }
    }
    if (session.runtime) {
      try {
        await this.#onSessionStopped();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "翻訳セッションの停止処理に失敗しました");
    }
    return true;
  }

  public async stopAll(reason: string): Promise<void> {
    const guildIds = [...this.#sessions.keys()];
    const results = await Promise.allSettled(
      guildIds.map(async (guildId) => this.stop(guildId, reason)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result): unknown => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "一部の翻訳セッションを正常に停止できませんでした");
    }
  }

  #assertCurrent(session: ManagedSession): void {
    if (
      this.#sessions.get(session.guildId) !== session ||
      session.state === "STOPPING"
    ) {
      throw new ApplicationError(
        "SESSION_START_FAILED",
        "開始処理中に翻訳セッションが停止されました。",
      );
    }
  }

  #requireActiveRuntime(guildId: string): ManagedSession & { runtime: SessionRuntime } {
    const session = this.#sessions.get(guildId);
    if (session?.state !== "ACTIVE" || !session.runtime) {
      throw new ApplicationError(
        "SESSION_NOT_ACTIVE",
        "翻訳セッションは実行されていません。",
      );
    }
    return session as ManagedSession & { runtime: SessionRuntime };
  }
}
