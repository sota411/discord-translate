import type { RealtimeResult } from "@soniox/node";

import {
  languagesForPair,
  type LanguagePair,
} from "../domain/language-pair.js";
import type { DiscordCaptionGateway } from "./caption-gateway.js";

type UnsupportedLanguageWarningOptions = {
  pair: LanguagePair;
  captions: Pick<DiscordCaptionGateway, "postUnsupportedLanguageWarning">;
  onFailure: (reason: string, publicMessage: string, cause?: unknown) => void;
};

export class UnsupportedLanguageWarning {
  readonly #pairLanguages: ReadonlySet<string>;
  readonly #captions: Pick<DiscordCaptionGateway, "postUnsupportedLanguageWarning">;
  readonly #onFailure: UnsupportedLanguageWarningOptions["onFailure"];
  readonly #warnedUserIds = new Set<string>();

  public constructor(options: UnsupportedLanguageWarningOptions) {
    this.#pairLanguages = new Set(languagesForPair(options.pair));
    this.#captions = options.captions;
    this.#onFailure = options.onFailure;
  }

  public async handle(userId: string, result: RealtimeResult): Promise<void> {
    const hasUnsupportedLanguage = result.tokens.some((token) =>
      token.is_final &&
      token.translation_status === "none" &&
      token.language !== undefined &&
      !this.#pairLanguages.has(token.language)
    );
    if (!hasUnsupportedLanguage || this.#warnedUserIds.has(userId)) return;

    this.#warnedUserIds.add(userId);
    try {
      await this.#captions.postUnsupportedLanguageWarning();
    } catch (error) {
      this.#onFailure(
        "CAPTION_SEND_FAILED",
        "警告を字幕スレッドへ投稿できませんでした。",
        error,
      );
    }
  }
}
