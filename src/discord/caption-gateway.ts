import { ApplicationError } from "../domain/application-error.js";
import type {
  CaptionGateway,
  CaptionState,
  TranslationUtterance,
} from "../translation/utterance-processor.js";

export type CaptionMessagePayload = {
  content: string;
  allowedMentions: { parse: [] };
};

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

const languageLabels = {
  ja: "日本語",
  ko: "韓国語",
  en: "英語",
} as const;

const stateLabels: Readonly<Record<CaptionState, string>> = {
  pending: "再生待ち",
  played: "再生済み",
  not_played: "未再生",
  partial_failure: "一部再生後に失敗",
};

function renderCaption(utterance: TranslationUtterance, state: CaptionState): string {
  return [
    `[${languageLabels[utterance.sourceLanguage]} → ${languageLabels[utterance.targetLanguage]}] ${utterance.speakerDisplayName}`,
    `原文: ${utterance.originalText}`,
    `翻訳: ${utterance.translatedText}`,
    `音声: ${stateLabels[state]}`,
  ].join("\n");
}

function payload(utterance: TranslationUtterance, state: CaptionState): CaptionMessagePayload {
  const content = renderCaption(utterance, state);
  if (content.length > 2_000) {
    throw new ApplicationError(
      "CAPTION_SEND_FAILED",
      "字幕がDiscordの2,000文字上限を超えたため、翻訳を停止します。",
    );
  }
  return { content, allowedMentions: { parse: [] } };
}

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
      const message = await this.#channel.send(payload(utterance, utterance.state));
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
      await entry.message.edit(payload(entry.utterance, state));
      if (state !== "pending") this.#entries.delete(reference);
    } catch (error) {
      throw new ApplicationError(
        "CAPTION_SEND_FAILED",
        "字幕の状態をDiscordへ反映できないため、翻訳を停止します。",
        { cause: error },
      );
    }
  }
}
