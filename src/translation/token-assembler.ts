import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";

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

type OriginalBuffer = {
  text: string[];
  startMs?: number;
  endMs?: number;
};

export class TranslationTokenAssembler {
  readonly #languages: ReadonlySet<Language>;
  readonly #originals = new Map<Language, OriginalBuffer>();
  #sourceLanguage: Language | undefined;
  #targetLanguage: Language | undefined;
  #translation: string[] = [];

  public constructor(pair: LanguagePair) {
    this.#languages = new Set(languagesForPair(pair));
  }

  public accept(token: TranslationToken): void {
    if (!token.is_final) return;
    if (token.translation_status === "original" && this.#isPairLanguage(token.language)) {
      const original = this.#originals.get(token.language) ?? { text: [] };
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
      this.#originals.set(token.language, original);
      return;
    }

    if (
      token.translation_status !== "translation" ||
      !this.#isPairLanguage(token.language) ||
      !this.#isPairLanguage(token.source_language) ||
      token.language === token.source_language
    ) {
      return;
    }
    if (!this.#sourceLanguage) {
      this.#sourceLanguage = token.source_language;
      this.#targetLanguage = token.language;
    }
    if (
      token.source_language === this.#sourceLanguage &&
      token.language === this.#targetLanguage
    ) {
      this.#translation.push(token.text);
    }
  }

  public flush(): FinalizedUtterance | undefined {
    const sourceLanguage = this.#sourceLanguage;
    const targetLanguage = this.#targetLanguage;
    const original = sourceLanguage ? this.#originals.get(sourceLanguage) : undefined;
    const originalText = original?.text.join("") ?? "";
    const translatedText = this.#translation.join("");
    const sourceDurationMs = original?.startMs !== undefined && original.endMs !== undefined
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
    this.#originals.clear();
    this.#sourceLanguage = undefined;
    this.#targetLanguage = undefined;
    this.#translation = [];
  }
}
