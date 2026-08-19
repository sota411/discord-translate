import { ThreadAutoArchiveDuration } from "discord.js";

import type { LanguagePair } from "../domain/language-pair.js";
import { languagePairLabels } from "../domain/language-pair.js";
import type { PlaybackMode } from "../session/session-settings.js";
import {
  createSessionCardMessagePayload,
  createStopMessagePayload,
  type ComponentsMessagePayload,
  type SessionCardView,
} from "./message-payload.js";

const closeOperationTimeoutMs = 5_000;

export type SessionCardPayload = ComponentsMessagePayload;

export type SessionThreadChannel = {
  send(payload: SessionCardPayload): Promise<{
    edit(payload: SessionCardPayload): Promise<unknown>;
    delete(): Promise<unknown>;
  }>;
  setArchived(archived: boolean): Promise<unknown>;
};

export type SessionCardMessage = {
  edit(payload: SessionCardPayload): Promise<unknown>;
  startThread(options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
  }): Promise<SessionThreadChannel>;
};

export type SessionParentChannel = {
  send(payload: SessionCardPayload): Promise<SessionCardMessage>;
};

type SessionPresentationWarning = (
  operation: "card_update" | "stop_notice" | "thread_archive",
  error: unknown,
) => void;

type OpenSessionPresentationInput = {
  channel: SessionParentChannel;
  sessionId: string;
  pair: LanguagePair;
  participantDisplayNames: readonly string[];
  playbackMode: PlaybackMode;
  audioEnabled: boolean;
  queueWarningMs: number;
  startedAt: Date;
  now?: () => Date;
  onWarning?: SessionPresentationWarning;
};

type SessionPresentationUpdate = Pick<
  SessionCardView,
  "participantDisplayNames" | "playbackMode" | "audioEnabled" | "queueWaitMs"
>;

export class DiscordSessionPresentation {
  readonly #message: SessionCardMessage;
  readonly #thread: SessionThreadChannel;
  readonly #startedAt: Date;
  readonly #now: () => Date;
  readonly #onWarning: SessionPresentationWarning;
  #view: SessionCardView;
  #pendingUpdate: Promise<void> = Promise.resolve();
  #closeWork: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(input: {
    message: SessionCardMessage;
    thread: SessionThreadChannel;
    view: SessionCardView;
    startedAt: Date;
    now: () => Date;
    onWarning: SessionPresentationWarning;
  }) {
    this.#message = input.message;
    this.#thread = input.thread;
    this.#view = input.view;
    this.#startedAt = input.startedAt;
    this.#now = input.now;
    this.#onWarning = input.onWarning;
  }

  public static async open(
    input: OpenSessionPresentationInput,
  ): Promise<DiscordSessionPresentation> {
    const now = input.now ?? (() => new Date());
    const view: SessionCardView = {
      sessionId: input.sessionId,
      pair: input.pair,
      participantDisplayNames: [...input.participantDisplayNames],
      elapsedMs: Math.max(0, now().getTime() - input.startedAt.getTime()),
      queueWaitMs: 0,
      queueWarningMs: input.queueWarningMs,
      playbackMode: input.playbackMode,
      audioEnabled: input.audioEnabled,
      active: true,
    };
    const message = await input.channel.send(createSessionCardMessagePayload(view));
    let thread: SessionThreadChannel;
    try {
      thread = await message.startThread({
        name: `翻訳・${languagePairLabels[input.pair]}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      });
    } catch (error) {
      try {
        await message.edit(createSessionCardMessagePayload({
          ...view,
          active: false,
          stopReason: "START_FAILED",
        }));
      } catch (updateError) {
        input.onWarning?.("card_update", updateError);
      }
      throw error;
    }
    return new DiscordSessionPresentation({
      message,
      thread,
      view,
      startedAt: input.startedAt,
      now,
      onWarning: input.onWarning ?? (() => undefined),
    });
  }

  public get captionChannel(): SessionThreadChannel {
    return this.#thread;
  }

  public update(update: SessionPresentationUpdate): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#view = {
      ...this.#view,
      ...update,
      participantDisplayNames: [...update.participantDisplayNames],
      elapsedMs: Math.max(0, this.#now().getTime() - this.#startedAt.getTime()),
    };
    const payload = createSessionCardMessagePayload(this.#view);
    const operation = this.#pendingUpdate.then(async () => {
      await this.#message.edit(payload);
    });
    this.#pendingUpdate = operation.catch((error: unknown) => {
      this.#onWarning("card_update", error);
    });
    return this.#pendingUpdate;
  }

  public close(reason: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#view = {
      ...this.#view,
      active: false,
      elapsedMs: Math.max(0, this.#now().getTime() - this.#startedAt.getTime()),
      stopReason: reason,
    };
    const pendingUpdate = this.#pendingUpdate;
    const finalCard = createSessionCardMessagePayload(this.#view);
    this.#closeWork = this.#finishClose(pendingUpdate, reason, finalCard).catch((error: unknown) => {
      this.#onWarning("thread_archive", error);
    });
    return Promise.resolve();
  }

  public rearchiveAfterClose(): void {
    if (!this.#closed) return;
    const operation = this.#closeWork.then(async () => {
      await this.#settleWithin(this.#thread.setArchived(true), "thread_archive");
    });
    this.#closeWork = operation.catch((error: unknown) => {
      this.#onWarning("thread_archive", error);
    });
  }

  async #finishClose(
    pendingUpdate: Promise<void>,
    reason: string,
    finalCard: SessionCardPayload,
  ): Promise<void> {
    const pendingUpdateStatus = await this.#settleWithin(
      pendingUpdate,
      "card_update",
    );
    const stopNotice = this.#thread.send(createStopMessagePayload(reason));
    const stopNoticeStatus = await this.#settleWithin(stopNotice, "stop_notice");
    await this.#settleWithin(this.#message.edit(finalCard), "card_update");
    await this.#settleWithin(this.#thread.setArchived(true), "thread_archive");

    if (pendingUpdateStatus === "timeout") {
      void pendingUpdate.then(async () => {
        await this.#settleWithin(this.#message.edit(finalCard), "card_update");
        await this.#settleWithin(this.#thread.setArchived(true), "thread_archive");
      }, () => undefined);
    }
    if (stopNoticeStatus === "timeout") {
      void stopNotice.then(async () => {
        await this.#settleWithin(this.#thread.setArchived(true), "thread_archive");
      }, () => undefined);
    }
  }

  async #settleWithin(
    operation: Promise<unknown>,
    warningOperation: Parameters<SessionPresentationWarning>[0],
  ): Promise<"settled" | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), closeOperationTimeoutMs);
      timer.unref();
    });
    const result = await Promise.race([
      operation.then(
        () => "settled" as const,
        (error: unknown) => {
          this.#onWarning(warningOperation, error);
          return "settled" as const;
        },
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      this.#onWarning(
        warningOperation,
        new Error("Discordのセッション表示更新が時間内に完了しませんでした。"),
      );
    }
    return result;
  }
}
