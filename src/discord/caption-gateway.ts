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

type DiscordCaptionGatewayOptions = {
  failurePolicy?: CaptionFailurePolicy;
  onWarning?: (operation: CaptionWarningOperation, error: unknown) => void;
  onClosedOperationSettled?: () => void;
};

export class DiscordCaptionGateway implements CaptionGateway {
  readonly #channel: CaptionTextChannel;
  readonly #entries = new Map<number, CaptionEntry>();
  readonly #interimMessages = new Map<string, EditableCaptionMessage>();
  readonly #operations = new Map<string, Promise<unknown>>();
  readonly #onWarning: (operation: CaptionWarningOperation, error: unknown) => void;
  readonly #onClosedOperationSettled: () => void;
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
  }

  public setFailurePolicy(policy: CaptionFailurePolicy): void {
    this.#failurePolicy = policy;
  }

  public preview(interim: InterimCaptionInput): Promise<void> {
    if (this.#closed || (interim.originalText.length === 0 && interim.translatedText.length === 0)) {
      return Promise.resolve();
    }
    return this.#serialize(interim.utteranceId, async () => {
      if (this.#closed) return;
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
      } catch (error) {
        this.#onWarning("caption_preview", error);
        if (!existing && this.#failurePolicy === "stop_session") {
          throw new ApplicationError(
            "CAPTION_SEND_FAILED",
            "仮字幕をDiscordへ投稿できないため、翻訳を停止します。",
            { cause: error },
          );
        }
      }
    });
  }

  public async post(
    utterance: TranslationUtterance & { state: CaptionState },
  ): Promise<number | undefined> {
    if (this.#closed) return undefined;
    return this.#serialize(utterance.utteranceId, async () => {
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
    });
  }

  public discardPreview(utteranceId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#serialize(utteranceId, async () => {
      if (this.#closed) return;
      const message = this.#interimMessages.get(utteranceId);
      this.#interimMessages.delete(utteranceId);
      if (!message) return;
      try {
        await message.delete();
      } catch (error) {
        this.#onWarning("caption_update", error);
      }
    });
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
    this.#operations.clear();
    return Promise.resolve();
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#operations.set(key, current);
    const settled = (): void => {
      if (this.#operations.get(key) === current) this.#operations.delete(key);
      this.#notifyClosedOperationSettled();
    };
    void current.then(
      settled,
      settled,
    );
    return current;
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
