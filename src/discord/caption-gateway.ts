import { performance } from "node:perf_hooks";

import type { APIRequest, RateLimitData, REST, ResponseLike } from "discord.js";

import { ApplicationError } from "../domain/application-error.js";
import type {
  CaptionGateway,
  CaptionState,
  TranslationUtterance,
} from "../translation/utterance-processor.js";
import type { CaptionFailurePolicy } from "../session/session-settings.js";
import {
  createCaptionMessagePayload,
  createInterimCaptionMessagePayload,
  createUnsupportedLanguageMessagePayload,
  type ComponentsMessagePayload,
} from "./message-payload.js";

export type CaptionMessagePayload = ComponentsMessagePayload;

export type EditableCaptionMessage = {
  edit(payload: CaptionMessagePayload): Promise<unknown>;
  delete(): Promise<unknown>;
};

export type CaptionTextChannel = {
  send(payload: CaptionMessagePayload): Promise<EditableCaptionMessage>;
};

type CaptionEntry = {
  message: EditableCaptionMessage;
  utterance: TranslationUtterance;
};

export type InterimCaptionInput = {
  utteranceId: string;
  speakerDisplayName: string;
  originalText: string;
  translatedText: string;
};

export type CaptionWarningOperation =
  | "caption_preview"
  | "caption_post"
  | "caption_update"
  | "unsupported_language_warning";

export type CaptionDeliveryObservation = {
  trace_id: string;
  outcome: "posted" | "discarded";
  succeeded: boolean;
  preview_requested: number;
  preview_sent: number;
  preview_coalesced: number;
  final_wait_ms: number;
  final_delivery_ms: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type PreviewWork = {
  input: InterimCaptionInput;
  deferred: Deferred<undefined>;
};

type TerminalWork =
  | {
      kind: "post";
      input: TranslationUtterance & { state: CaptionState };
      requestedAt: number;
      started: boolean;
      deferred: Deferred<number | undefined>;
    }
  | {
      kind: "discard";
      requestedAt: number;
      started: boolean;
      deferred: Deferred<undefined>;
    };

type CaptionWorker = {
  utteranceId: string;
  running: boolean;
  activePreview?: PreviewWork;
  pendingPreview?: PreviewWork;
  previewTimer?: NodeJS.Timeout;
  lastPreview?: InterimCaptionInput;
  terminal?: TerminalWork;
  previewRequested: number;
  previewSent: number;
  previewCoalesced: number;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type DiscordCaptionGatewayOptions = {
  rateLimits?: { rest: REST; channelId: string };
  failurePolicy?: CaptionFailurePolicy;
  onWarning?: (operation: CaptionWarningOperation, error: unknown) => void;
  onClosedOperationSettled?: () => void;
  observeDelivery?: (observation: CaptionDeliveryObservation) => void;
};

export class DiscordCaptionGateway implements CaptionGateway {
  readonly #channel: CaptionTextChannel;
  readonly #entries = new Map<number, CaptionEntry>();
  readonly #interimMessages = new Map<string, EditableCaptionMessage>();
  readonly #workers = new Map<string, CaptionWorker>();
  readonly #onWarning: (operation: CaptionWarningOperation, error: unknown) => void;
  readonly #onClosedOperationSettled: () => void;
  readonly #observeDelivery: (observation: CaptionDeliveryObservation) => void;
  readonly #unsubscribeRateLimits?: () => void;
  #nextPreviewEditAt = 0;
  #previewEditIntervalMs = 0;
  #previewEditResetAt = 0;
  #previewEditsBlocked = false;
  #failurePolicy: CaptionFailurePolicy;
  #nextReference = 1;
  #closed = false;

  public constructor(
    channel: CaptionTextChannel,
    options: DiscordCaptionGatewayOptions = {},
  ) {
    this.#channel = channel;
    this.#failurePolicy = options.failurePolicy ?? "continue_audio";
    this.#onWarning = options.onWarning ?? (() => undefined);
    this.#onClosedOperationSettled = options.onClosedOperationSettled ?? (() => undefined);
    this.#observeDelivery = options.observeDelivery ?? (() => undefined);
    if (options.rateLimits) {
      const { rest, channelId } = options.rateLimits;
      let editBucket: string | undefined;
      const onResponse = (request: APIRequest, response: ResponseLike): void => {
        if (!request.path.startsWith(`/channels/${channelId}/messages`)) return;
        const bucket = response.headers.get("X-RateLimit-Bucket")?.trim();
        if (request.method !== "PATCH" && (editBucket === undefined || bucket !== editBucket)) {
          return;
        }
        const remainingText = response.headers.get("X-RateLimit-Remaining")?.trim();
        const resetText = response.headers.get("X-RateLimit-Reset-After")?.trim();
        const remaining = Number(remainingText);
        const resetMs = Number(resetText) * 1_000;
        if (!bucket || remainingText === undefined || resetText === undefined ||
          !/^\d+$/u.test(remainingText) || !/^\d+(?:\.\d+)?$/u.test(resetText) ||
          !Number.isSafeInteger(remaining) || !Number.isFinite(resetMs)) {
          this.#onWarning("caption_preview", new Error("Discordの字幕編集制限ヘッダーが不正です。"));
          this.#previewEditsBlocked = true;
          return;
        }
        if (request.method === "PATCH") editBucket = bucket;
        const offset = typeof rest.options.offset === "function"
          ? rest.options.offset(request.route)
          : rest.options.offset;
        // Spread previews over the remaining window, leaving room for the final edit.
        this.#previewEditIntervalMs = Math.ceil((resetMs + offset) / Math.max(1, remaining));
        this.#previewEditResetAt = Date.now() + resetMs + offset;
        this.#nextPreviewEditAt = Math.max(
          this.#nextPreviewEditAt,
          Date.now() + this.#previewEditIntervalMs,
        );
        const resumeBlockedPreviews = this.#previewEditsBlocked;
        this.#previewEditsBlocked = false;
        if (resumeBlockedPreviews) {
          for (const worker of this.#workers.values()) {
            if (worker.running || worker.previewTimer || worker.terminal || !worker.pendingPreview) continue;
            const pending = worker.pendingPreview;
            delete worker.pendingPreview;
            this.#startPreview(worker, pending);
          }
        }
      };
      const onRateLimited = (data: RateLimitData): void => {
        const messageRoute = data.route === "/channels/:id/messages" ||
          data.route === "/channels/:id/messages/:id";
        const appliesToEdits = data.majorParameter === channelId && messageRoute && (
          editBucket === undefined
            ? data.method === "PATCH" && data.route === "/channels/:id/messages/:id"
            : data.hash === editBucket
        );
        if (data.global || appliesToEdits) {
          this.#nextPreviewEditAt = Math.max(this.#nextPreviewEditAt, Date.now() + data.retryAfter);
        }
      };
      rest.on("response", onResponse);
      rest.on("rateLimited", onRateLimited);
      this.#unsubscribeRateLimits = () => {
        rest.off("response", onResponse);
        rest.off("rateLimited", onRateLimited);
      };
    }
  }

  public setFailurePolicy(policy: CaptionFailurePolicy): void {
    this.#failurePolicy = policy;
  }

  public preview(interim: InterimCaptionInput): Promise<void> {
    if (this.#closed || (interim.originalText.length === 0 && interim.translatedText.length === 0)) {
      return Promise.resolve();
    }
    const worker = this.#worker(interim.utteranceId);
    worker.previewRequested += 1;
    const work: PreviewWork = {
      input: interim,
      deferred: createDeferred<undefined>(),
    };
    if (worker.terminal) {
      worker.previewCoalesced += 1;
      work.deferred.resolve(undefined);
      return work.deferred.promise;
    }
    if (!worker.running && !worker.previewTimer && !worker.pendingPreview) {
      this.#startPreview(worker, work);
      return work.deferred.promise;
    }
    if (worker.pendingPreview) {
      worker.previewCoalesced += 1;
      worker.pendingPreview.deferred.resolve(undefined);
    }
    worker.pendingPreview = work;
    return work.deferred.promise;
  }

  public async post(
    utterance: TranslationUtterance & { state: CaptionState },
  ): Promise<number | undefined> {
    if (this.#closed) return undefined;
    const worker = this.#worker(utterance.utteranceId);
    if (worker.terminal) {
      return worker.terminal.kind === "post"
        ? worker.terminal.deferred.promise
        : worker.terminal.deferred.promise.then(() => undefined);
    }
    const terminal: Extract<TerminalWork, { kind: "post" }> = {
      kind: "post",
      input: utterance,
      requestedAt: performance.now(),
      started: false,
      deferred: createDeferred<number | undefined>(),
    };
    worker.terminal = terminal;
    this.#dropPendingPreview(worker);
    if (!worker.running) this.#startTerminal(worker, terminal);
    return terminal.deferred.promise;
  }

  public discardPreview(utteranceId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const worker = this.#worker(utteranceId);
    if (worker.terminal) {
      return worker.terminal.kind === "discard"
        ? worker.terminal.deferred.promise
        : worker.terminal.deferred.promise.then(() => undefined);
    }
    const terminal: Extract<TerminalWork, { kind: "discard" }> = {
      kind: "discard",
      requestedAt: performance.now(),
      started: false,
      deferred: createDeferred<undefined>(),
    };
    worker.terminal = terminal;
    this.#dropPendingPreview(worker);
    if (!worker.running) this.#startTerminal(worker, terminal);
    return terminal.deferred.promise;
  }

  public async update(reference: number, state: CaptionState): Promise<void> {
    const entry = this.#entries.get(reference);
    if (!entry) return;
    try {
      await entry.message.edit(createCaptionMessagePayload(entry.utterance, state));
    } catch (error) {
      this.#onWarning("caption_update", error);
    } finally {
      if (state !== "pending") this.#entries.delete(reference);
    }
  }

  public async postUnsupportedLanguageWarning(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#channel.send(createUnsupportedLanguageMessagePayload());
    } catch (error) {
      this.#onWarning("unsupported_language_warning", error);
    } finally {
      this.#notifyClosedOperationSettled();
    }
  }

  public close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribeRateLimits?.();
    this.#interimMessages.clear();
    this.#entries.clear();
    for (const worker of this.#workers.values()) {
      if (worker.previewTimer) clearTimeout(worker.previewTimer);
      worker.activePreview?.deferred.resolve(undefined);
      delete worker.activePreview;
      worker.pendingPreview?.deferred.resolve(undefined);
      delete worker.pendingPreview;
      if (worker.terminal) {
        if (worker.terminal.kind === "post") {
          worker.terminal.deferred.resolve(undefined);
        } else {
          worker.terminal.deferred.resolve(undefined);
        }
        delete worker.terminal;
      }
    }
    this.#workers.clear();
    return Promise.resolve();
  }

  #worker(utteranceId: string): CaptionWorker {
    const existing = this.#workers.get(utteranceId);
    if (existing) return existing;
    const created: CaptionWorker = {
      utteranceId,
      running: false,
      previewRequested: 0,
      previewSent: 0,
      previewCoalesced: 0,
    };
    this.#workers.set(utteranceId, created);
    return created;
  }

  #startPreview(worker: CaptionWorker, work: PreviewWork): void {
    const last = worker.lastPreview;
    if (last?.originalText === work.input.originalText &&
      last.translatedText === work.input.translatedText &&
      last.speakerDisplayName === work.input.speakerDisplayName) {
      worker.previewCoalesced += 1;
      work.deferred.resolve(undefined);
      return;
    }
    if (this.#interimMessages.has(worker.utteranceId)) {
      if (this.#previewEditsBlocked) {
        worker.pendingPreview = work;
        return;
      }
      const delayMs = this.#nextPreviewEditAt - Date.now();
      if (delayMs > 0) {
        worker.pendingPreview = work;
        worker.previewTimer = setTimeout(() => {
          delete worker.previewTimer;
          this.#advance(worker);
        }, delayMs);
        worker.previewTimer.unref();
        return;
      }
      this.#nextPreviewEditAt = Date.now() + (
        Date.now() < this.#previewEditResetAt ? this.#previewEditIntervalMs : 0
      );
    }
    worker.running = true;
    worker.activePreview = work;
    void (async () => {
      try {
        if (await this.#performPreview(work.input)) {
          worker.previewSent += 1;
          worker.lastPreview = work.input;
        }
        work.deferred.resolve(undefined);
      } catch (error) {
        work.deferred.reject(error);
      } finally {
        if (worker.activePreview === work) delete worker.activePreview;
        worker.running = false;
        this.#advance(worker);
        this.#notifyClosedOperationSettled();
      }
    })();
  }

  #advance(worker: CaptionWorker): void {
    if (this.#closed) {
      worker.pendingPreview?.deferred.resolve(undefined);
      delete worker.pendingPreview;
      if (worker.terminal && !worker.terminal.started) {
        if (worker.terminal.kind === "post") {
          worker.terminal.deferred.resolve(undefined);
        } else {
          worker.terminal.deferred.resolve(undefined);
        }
        delete worker.terminal;
      }
      return;
    }
    if (worker.terminal) {
      this.#startTerminal(worker, worker.terminal);
      return;
    }
    if (worker.pendingPreview) {
      const pending = worker.pendingPreview;
      delete worker.pendingPreview;
      this.#startPreview(worker, pending);
    }
  }

  #startTerminal(worker: CaptionWorker, terminal: TerminalWork): void {
    worker.running = true;
    terminal.started = true;
    const startedAt = performance.now();
    void (async () => {
      let succeeded = false;
      try {
        if (terminal.kind === "post") {
          const reference = await this.#performPost(terminal.input);
          succeeded = reference !== undefined;
          terminal.deferred.resolve(reference);
        } else {
          succeeded = await this.#performDiscard(worker.utteranceId);
          terminal.deferred.resolve(undefined);
        }
      } catch (error) {
        terminal.deferred.reject(error);
      } finally {
        const completedAt = performance.now();
        this.#observeDelivery({
          trace_id: worker.utteranceId,
          outcome: terminal.kind === "post" ? "posted" : "discarded",
          succeeded,
          preview_requested: worker.previewRequested,
          preview_sent: worker.previewSent,
          preview_coalesced: worker.previewCoalesced,
          final_wait_ms: Math.max(0, Math.round(startedAt - terminal.requestedAt)),
          final_delivery_ms: Math.max(0, Math.round(completedAt - startedAt)),
        });
        worker.running = false;
        if (this.#workers.get(worker.utteranceId) === worker) {
          this.#workers.delete(worker.utteranceId);
        }
        this.#notifyClosedOperationSettled();
      }
    })();
  }

  #dropPendingPreview(worker: CaptionWorker): void {
    if (worker.previewTimer) {
      clearTimeout(worker.previewTimer);
      delete worker.previewTimer;
    }
    if (!worker.pendingPreview) return;
    worker.previewCoalesced += 1;
    worker.pendingPreview.deferred.resolve(undefined);
    delete worker.pendingPreview;
  }

  async #performPreview(interim: InterimCaptionInput): Promise<boolean> {
    if (this.#closed) return false;
    const existing = this.#interimMessages.get(interim.utteranceId);
    try {
      const payload = createInterimCaptionMessagePayload(interim);
      if (existing) {
        await existing.edit(payload);
      } else {
        const message = await this.#channel.send(payload);
        if (!this.#isClosed()) {
          this.#interimMessages.set(interim.utteranceId, message);
        }
      }
      return true;
    } catch (error) {
      this.#onWarning("caption_preview", error);
      if (!existing && this.#failurePolicy === "stop_session") {
        throw new ApplicationError(
          "CAPTION_SEND_FAILED",
          "仮字幕をDiscordへ投稿できないため、翻訳を停止します。",
          { cause: error },
        );
      }
      return false;
    }
  }

  async #performPost(
    utterance: TranslationUtterance & { state: CaptionState },
  ): Promise<number | undefined> {
    if (this.#isClosed()) return undefined;
    let message = this.#interimMessages.get(utterance.utteranceId);
    let payload: CaptionMessagePayload;
    try {
      payload = createCaptionMessagePayload(utterance, utterance.state);
    } catch (error) {
      if (message) {
        this.#interimMessages.delete(utterance.utteranceId);
        this.#onWarning("caption_update", error);
        try {
          await message.delete();
        } catch (deleteError) {
          this.#onWarning("caption_update", deleteError);
        }
        return undefined;
      }
      return this.#handlePostFailure(error);
    }
    this.#interimMessages.delete(utterance.utteranceId);
    if (message) {
      try {
        await message.edit(payload);
      } catch (error) {
        this.#onWarning("caption_update", error);
        try {
          await message.delete();
        } catch (deleteError) {
          this.#onWarning("caption_update", deleteError);
          return undefined;
        }
        message = undefined;
      }
    }
    if (this.#isClosed()) return undefined;
    try {
      message ??= await this.#channel.send(payload);
    } catch (error) {
      return this.#handlePostFailure(error);
    }
    if (this.#closed) return undefined;
    const reference = this.#nextReference;
    this.#nextReference += 1;
    this.#entries.set(reference, { message, utterance });
    return reference;
  }

  async #performDiscard(utteranceId: string): Promise<boolean> {
    if (this.#closed) return false;
    const message = this.#interimMessages.get(utteranceId);
    this.#interimMessages.delete(utteranceId);
    if (!message) return true;
    try {
      await message.delete();
      return true;
    } catch (error) {
      this.#onWarning("caption_update", error);
      return false;
    }
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  #notifyClosedOperationSettled(): void {
    if (this.#closed) this.#onClosedOperationSettled();
  }

  #handlePostFailure(error: unknown): undefined {
    this.#onWarning("caption_post", error);
    if (this.#failurePolicy === "continue_audio") return undefined;
    if (error instanceof ApplicationError && error.code === "CAPTION_SEND_FAILED") {
      throw error;
    }
    throw new ApplicationError(
      "CAPTION_SEND_FAILED",
      "字幕をDiscordへ投稿できないため、翻訳を停止します。",
      { cause: error },
    );
  }
}
