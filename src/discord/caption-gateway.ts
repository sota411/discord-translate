import { ApplicationError } from "../domain/application-error.js";
import type {
  CaptionGateway,
  CaptionState,
  TranslationUtterance,
} from "../translation/utterance-processor.js";
import {
  createCaptionMessagePayload,
  createUnsupportedLanguageMessagePayload,
  type ComponentsMessagePayload,
} from "./message-payload.js";

export type CaptionMessagePayload = ComponentsMessagePayload;

export type EditableCaptionMessage = {
  edit(payload: CaptionMessagePayload): Promise<unknown>;
};

export type CaptionTextChannel = {
  send(payload: CaptionMessagePayload): Promise<EditableCaptionMessage>;
};

type CaptionEntry = {
  message: EditableCaptionMessage;
  utterance: TranslationUtterance;
};

export class DiscordCaptionGateway implements CaptionGateway {
  readonly #channel: CaptionTextChannel;
  readonly #entries = new Map<number, CaptionEntry>();
  #nextReference = 1;

  public constructor(channel: CaptionTextChannel) {
    this.#channel = channel;
  }

  public async post(
    utterance: TranslationUtterance & { state: CaptionState },
  ): Promise<number> {
    try {
      const message = await this.#channel.send(
        createCaptionMessagePayload(utterance, utterance.state),
      );
      const reference = this.#nextReference;
      this.#nextReference += 1;
      this.#entries.set(reference, { message, utterance });
      return reference;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "CAPTION_SEND_FAILED",
        "字幕をDiscordへ投稿できないため、翻訳を停止します。",
        { cause: error },
      );
    }
  }

  public async update(reference: number, state: CaptionState): Promise<void> {
    const entry = this.#entries.get(reference);
    if (!entry) return;
    try {
      await entry.message.edit(createCaptionMessagePayload(entry.utterance, state));
      if (state !== "pending") this.#entries.delete(reference);
    } catch (error) {
      throw new ApplicationError(
        "CAPTION_SEND_FAILED",
        "字幕の状態をDiscordへ反映できないため、翻訳を停止します。",
        { cause: error },
      );
    }
  }

  public async postUnsupportedLanguageWarning(): Promise<void> {
    try {
      await this.#channel.send(createUnsupportedLanguageMessagePayload());
    } catch (error) {
      throw new ApplicationError(
        "CAPTION_SEND_FAILED",
        "対応言語外の警告をDiscordへ投稿できないため、翻訳を停止します。",
        { cause: error },
      );
    }
  }
}
