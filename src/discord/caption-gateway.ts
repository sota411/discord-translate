import { performance } from "node:perf_hooks";

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
  pendingPreview?: PreviewWork;
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
    if (!worker.running) {
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
    this.#interimMessages.clear();
    this.#entries.clear();
    for (const worker of this.#workers.values()) {
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
    worker.running = true;
    void (async () => {
      try {
        if (await this.#performPreview(work.input)) worker.previewSent += 1;
        work.deferred.resolve(undefined);
      } catch (error) {
        work.deferred.reject(error);
      } finally {
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
          await this.#performDiscard(worker.utteranceId);
          succeeded = true;
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

  async #performDiscard(utteranceId: string): Promise<void> {
    if (this.#closed) return;
    const message = this.#interimMessages.get(utteranceId);
    this.#interimMessages.delete(utteranceId);
    if (!message) return;
    try {
      await message.delete();
    } catch (error) {
      this.#onWarning("caption_update", error);
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
