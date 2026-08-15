import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";
import { ApplicationError } from "../domain/application-error.js";

export type TranslationToken = {
  text: string;
  is_final: boolean;
  language?: string | undefined;
  source_language?: string | undefined;
  translation_status?: "none" | "original" | "translation" | undefined;
  start_ms?: number | undefined;
  end_ms?: number | undefined;
};

export type FinalizedUtterance = {
  sourceLanguage: Language;
  targetLanguage: Language;
  originalText: string;
  translatedText: string;
  sourceDurationMs: number;
};

export type AcceptedTranslationToken = {
  sourceLanguage: Language;
  targetLanguage: Language;
  text: string;
};

type OriginalBuffer = {
  text: string[];
  startMs?: number;
  endMs?: number;
};

type TranslationTokenAssemblerLimits = {
  maxSourceDurationMs: number;
  maxInputCharacters: number;
};

export class TranslationTokenAssembler {
  readonly #languages: ReadonlySet<Language>;
  readonly #maxSourceDurationMs: number;
  readonly #maxInputCharacters: number;
  #original: OriginalBuffer = { text: [] };
  #sourceLanguage: Language | undefined;
  #targetLanguage: Language | undefined;
  #translation: string[] = [];
  #translationCharacters = 0;

  public constructor(pair: LanguagePair, limits: TranslationTokenAssemblerLimits) {
    this.#languages = new Set(languagesForPair(pair));
    this.#maxSourceDurationMs = limits.maxSourceDurationMs;
    this.#maxInputCharacters = limits.maxInputCharacters;
  }

  public accept(token: TranslationToken): AcceptedTranslationToken | undefined {
    if (!token.is_final) return undefined;
    if (token.translation_status === "original") {
      const original = this.#original;
      original.text.push(token.text);
      if (token.start_ms !== undefined) {
        original.startMs = original.startMs === undefined
          ? token.start_ms
          : Math.min(original.startMs, token.start_ms);
      }
      if (token.end_ms !== undefined) {
        original.endMs = original.endMs === undefined
          ? token.end_ms
          : Math.max(original.endMs, token.end_ms);
      }
      if (
        original.startMs !== undefined &&
        original.endMs !== undefined &&
        original.endMs - original.startMs > this.#maxSourceDurationMs
      ) {
        this.#throwTooLong();
      }
      return undefined;
    }

    if (
      token.translation_status !== "translation" ||
      !this.#isPairLanguage(token.language) ||
      !this.#isPairLanguage(token.source_language) ||
      token.language === token.source_language
    ) {
      return undefined;
    }
    if (
      this.#sourceLanguage !== undefined &&
      this.#targetLanguage !== undefined &&
      (
        token.source_language !== this.#sourceLanguage ||
        token.language !== this.#targetLanguage
      )
    ) {
      throw new ApplicationError(
        "SONIOX_STREAM_FAILED",
        "同じ発話内で翻訳方向が変化したため、翻訳を停止します。",
      );
    }
    if (!this.#sourceLanguage) {
      this.#sourceLanguage = token.source_language;
      this.#targetLanguage = token.language;
    }
    if (
      token.source_language === this.#sourceLanguage &&
      token.language === this.#targetLanguage
    ) {
      this.#translationCharacters += Array.from(token.text).length;
      if (this.#translationCharacters > this.#maxInputCharacters) {
        this.#throwTooLong();
      }
      this.#translation.push(token.text);
      return {
        sourceLanguage: token.source_language,
        targetLanguage: token.language,
        text: token.text,
      };
    }
    return undefined;
  }

  public flush(): FinalizedUtterance | undefined {
    const sourceLanguage = this.#sourceLanguage;
    const targetLanguage = this.#targetLanguage;
    const original = this.#original;
    const originalText = original.text.join("");
    const translatedText = this.#translation.join("");
    const sourceDurationMs = original.startMs !== undefined && original.endMs !== undefined
      ? Math.max(0, original.endMs - original.startMs)
      : 0;
    this.#reset();

    if (!sourceLanguage || !targetLanguage || !originalText || !translatedText) {
      return undefined;
    }
    return {
      sourceLanguage,
      targetLanguage,
      originalText,
      translatedText,
      sourceDurationMs,
    };
  }

  #isPairLanguage(language: string | undefined): language is Language {
    return language !== undefined && this.#languages.has(language as Language);
  }

  #reset(): void {
    this.#original = { text: [] };
    this.#sourceLanguage = undefined;
    this.#targetLanguage = undefined;
    this.#translation = [];
    this.#translationCharacters = 0;
  }

  #throwTooLong(): never {
    throw new ApplicationError(
      "UTTERANCE_TOO_LONG",
      "UTTERANCE_TOO_LONG: 発話を短く区切って再実行してください。",
    );
  }
}
