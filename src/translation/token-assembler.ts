import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";
import { ApplicationError } from "../domain/application-error.js";
import type { RealtimeToken } from "@soniox/node";

export type TranslationToken = Pick<
  RealtimeToken,
  | "text"
  | "is_final"
  | "language"
  | "source_language"
  | "translation_status"
  | "start_ms"
  | "end_ms"
> & Partial<Pick<RealtimeToken, "confidence">>;

export type OriginalConfidenceSummary = {
  tokenCount: number;
  mean: number;
  min: number;
};

export type FinalizedUtterance = {
  sourceLanguage: Language;
  targetLanguage: Language;
  originalText: string;
  translatedText: string;
  sourceDurationMs: number;
  originalConfidence?: OriginalConfidenceSummary;
};

export type InterimUtterance = Pick<
  FinalizedUtterance,
  "originalText" | "translatedText"
>;

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
  #originalConfidenceCount = 0;
  #originalConfidenceSum = 0;
  #originalConfidenceMin = Number.POSITIVE_INFINITY;

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
      if (token.confidence !== undefined) {
        this.#originalConfidenceCount += 1;
        this.#originalConfidenceSum += token.confidence;
        this.#originalConfidenceMin = Math.min(
          this.#originalConfidenceMin,
          token.confidence,
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
    const originalConfidence = this.#originalConfidenceCount > 0
      ? {
          tokenCount: this.#originalConfidenceCount,
          mean: Math.round(
            (this.#originalConfidenceSum / this.#originalConfidenceCount) * 10_000,
          ) / 10_000,
          min: Math.round(this.#originalConfidenceMin * 10_000) / 10_000,
        }
      : undefined;
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
      ...(originalConfidence ? { originalConfidence } : {}),
    };
  }

  public preview(tokens: readonly TranslationToken[]): InterimUtterance | undefined {
    const originalText = [...this.#original.text];
    const originalCharactersByLanguage = new Map(this.#originalCharactersByLanguage);
    const translationsBySource = new Map<Language, TranslationBuffer>();
    for (const [sourceLanguage, translation] of this.#translationsBySource) {
      translationsBySource.set(sourceLanguage, {
        ...translation,
        text: [...translation.text],
      });
    }

    for (const token of tokens) {
      if (token.is_final) continue;
      if (token.translation_status === "original") {
        originalText.push(token.text);
        if (this.#isPairLanguage(token.language)) {
          originalCharactersByLanguage.set(
            token.language,
            (originalCharactersByLanguage.get(token.language) ?? 0) +
              Array.from(token.text).length,
          );
        }
        continue;
      }
      if (
        token.translation_status !== "translation" ||
        !this.#isPairLanguage(token.language) ||
        !this.#isPairLanguage(token.source_language) ||
        token.language === token.source_language
      ) {
        continue;
      }
      const translation = translationsBySource.get(token.source_language) ?? {
        sourceLanguage: token.source_language,
        targetLanguage: token.language,
        text: [],
        characters: 0,
      };
      translation.text.push(token.text);
      translation.characters += Array.from(token.text).length;
      translationsBySource.set(token.source_language, translation);
    }

    const translation = this.#selectTranslation(
      translationsBySource,
      originalCharactersByLanguage,
    );
    const translatedText = translation?.text.join("") ?? "";
    const joinedOriginalText = originalText.join("");
    if (!joinedOriginalText && !translatedText) return undefined;
    return {
      originalText: joinedOriginalText,
      translatedText,
    };
  }

  #isPairLanguage(language: string | undefined): language is Language {
    return language !== undefined && this.#languages.has(language as Language);
  }

  #reset(): void {
    this.#original = { text: [] };
    this.#originalCharactersByLanguage.clear();
    this.#translationsBySource.clear();
    this.#originalConfidenceCount = 0;
    this.#originalConfidenceSum = 0;
    this.#originalConfidenceMin = Number.POSITIVE_INFINITY;
  }

  #selectTranslation(
    translationsBySource: ReadonlyMap<Language, TranslationBuffer> =
      this.#translationsBySource,
    originalCharactersByLanguage: ReadonlyMap<Language, number> =
      this.#originalCharactersByLanguage,
  ): TranslationBuffer | undefined {
    let selected: TranslationBuffer | undefined;
    for (const candidate of translationsBySource.values()) {
      if (!selected) {
        selected = candidate;
        continue;
      }
      const candidateOriginalCharacters =
        originalCharactersByLanguage.get(candidate.sourceLanguage) ?? 0;
      const selectedOriginalCharacters =
        originalCharactersByLanguage.get(selected.sourceLanguage) ?? 0;
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
