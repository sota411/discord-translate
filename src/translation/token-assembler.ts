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

type TranslationBuffer = {
  sourceLanguage: Language;
  targetLanguage: Language;
  text: string[];
  characters: number;
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
  readonly #originalCharactersByLanguage = new Map<Language, number>();
  readonly #translationsBySource = new Map<Language, TranslationBuffer>();

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
      if (this.#isPairLanguage(token.language)) {
        this.#originalCharactersByLanguage.set(
          token.language,
          (this.#originalCharactersByLanguage.get(token.language) ?? 0) +
            Array.from(token.text).length,
        );
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
    const translation = this.#translationsBySource.get(token.source_language) ?? {
      sourceLanguage: token.source_language,
      targetLanguage: token.language,
      text: [],
      characters: 0,
    };
    translation.characters += Array.from(token.text).length;
    if (translation.characters > this.#maxInputCharacters) {
      this.#throwTooLong();
    }
    translation.text.push(token.text);
    this.#translationsBySource.set(token.source_language, translation);
    return {
      sourceLanguage: token.source_language,
      targetLanguage: token.language,
      text: token.text,
    };
  }

  public flush(): FinalizedUtterance | undefined {
    const translation = this.#selectTranslation();
    const original = this.#original;
    const originalText = original.text.join("");
    const translatedText = translation?.text.join("") ?? "";
    const sourceDurationMs = original.startMs !== undefined && original.endMs !== undefined
      ? Math.max(0, original.endMs - original.startMs)
      : 0;
    this.#reset();

    if (!translation || !originalText || !translatedText) {
      return undefined;
    }
    return {
      sourceLanguage: translation.sourceLanguage,
      targetLanguage: translation.targetLanguage,
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
    this.#originalCharactersByLanguage.clear();
    this.#translationsBySource.clear();
  }

  #selectTranslation(): TranslationBuffer | undefined {
    let selected: TranslationBuffer | undefined;
    for (const candidate of this.#translationsBySource.values()) {
      if (!selected) {
        selected = candidate;
        continue;
      }
      const candidateOriginalCharacters =
        this.#originalCharactersByLanguage.get(candidate.sourceLanguage) ?? 0;
      const selectedOriginalCharacters =
        this.#originalCharactersByLanguage.get(selected.sourceLanguage) ?? 0;
      if (
        candidateOriginalCharacters > selectedOriginalCharacters ||
        (
          candidateOriginalCharacters === selectedOriginalCharacters &&
          candidate.characters > selected.characters
        )
      ) {
        selected = candidate;
      }
    }
    return selected;
  }

  #throwTooLong(): never {
    throw new ApplicationError(
      "UTTERANCE_TOO_LONG",
      "UTTERANCE_TOO_LONG: 発話を短く区切って再実行してください。",
    );
  }
}
