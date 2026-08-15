import { randomUUID } from "node:crypto";

import { ApplicationError } from "../domain/application-error.js";
import type { LanguagePair } from "../domain/language-pair.js";

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
};

export type StartSessionInput = Omit<
  SessionDescriptor,
  "sessionId" | "state" | "startedAt"
>;

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
  updateParticipants(participantIds: readonly string[]): Promise<void>;
  stop(reason: string): Promise<void>;
};

export type TranslationSessionDriver = {
  start(
    session: Readonly<SessionDescriptor>,
    participantIds: readonly string[],
  ): Promise<SessionRuntime>;
};

type ManagedSession = SessionDescriptor & {
  runtime?: SessionRuntime;
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

    const startedAt = this.#now();
    const session: ManagedSession = {
      ...input,
      participantIds: [...input.participantIds],
      sessionId: this.#createId(),
      state: "AUTHORIZING",
      startedAt,
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
        sttStreams: 2,
        ttsStreams: 1,
        at: this.#now(),
      });
      this.#assertCurrent(session);
      session.state = "CONNECTING";
      session.runtime = await this.#driver.start(session, session.participantIds);
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
    await session.runtime.updateParticipants(participantIds);
    session.participantIds = [...participantIds];
  }

  public async stop(guildId: string, reason: string): Promise<boolean> {
    const session = this.#sessions.get(guildId);
    if (!session) {
      return false;
    }
    session.state = "STOPPING";
    const errors: unknown[] = [];
    try {
      await session.runtime?.stop(reason);
    } catch (error) {
      errors.push(error);
    } finally {
      if (this.#sessions.get(guildId) === session) {
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
}
