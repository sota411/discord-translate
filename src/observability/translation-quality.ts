import type { Language } from "../domain/language-pair.js";
import type { OriginalConfidenceSummary } from "../translation/token-assembler.js";

const minimumRepeatedNgramCount = 8;
const maximumNgramLength = 4;

export type RepeatedTranslation = {
  maxRepeatCount: number;
  ngramLength: number;
};

export type TranslationQualityLogFields = {
  trace_id: string;
  source_language: Language;
  target_language: Language;
  source_characters: number;
  translation_characters: number;
  translation_source_ratio: number;
  original_token_count: number;
  original_confidence_mean: number | null;
  original_confidence_min: number | null;
};

export type TranslationQualityAnomalyLogFields = {
  trace_id: string;
  source_language: Language;
  target_language: Language;
  source_characters: number;
  translation_characters: number;
  translation_source_ratio: number;
  max_repeat_count: number;
  ngram_length: number;
};

export type TranslationQualityObservation = {
  quality: TranslationQualityLogFields;
  anomaly?: TranslationQualityAnomalyLogFields;
};

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function words(text: string, language: Language): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase(language);
  return [...new Intl.Segmenter(language, { granularity: "word" }).segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
}

function ngramsEqual(
  tokens: readonly string[],
  leftStart: number,
  rightStart: number,
  length: number,
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (tokens[leftStart + offset] !== tokens[rightStart + offset]) return false;
  }
  return true;
}

export function findRepeatedTranslation(
  text: string,
  language: Language,
): RepeatedTranslation | undefined {
  const tokens = words(text, language);
  let strongest: RepeatedTranslation | undefined;
  for (
    let ngramLength = 1;
    ngramLength <= Math.min(maximumNgramLength, tokens.length);
    ngramLength += 1
  ) {
    for (let start = 0; start + ngramLength * minimumRepeatedNgramCount <= tokens.length;) {
      let repeatCount = 1;
      while (
        start + ngramLength * (repeatCount + 1) <= tokens.length &&
        ngramsEqual(tokens, start, start + ngramLength * repeatCount, ngramLength)
      ) {
        repeatCount += 1;
      }
      if (
        repeatCount >= minimumRepeatedNgramCount &&
        (
          !strongest ||
          repeatCount > strongest.maxRepeatCount ||
          (
            repeatCount === strongest.maxRepeatCount &&
            ngramLength < strongest.ngramLength
          )
        )
      ) {
        strongest = { maxRepeatCount: repeatCount, ngramLength };
      }
      start += Math.max(1, ngramLength * repeatCount);
    }
  }
  return strongest;
}

export function createTranslationQualityObservation(input: {
  traceId: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  originalText: string;
  translatedText: string;
  originalConfidence?: OriginalConfidenceSummary;
}): TranslationQualityObservation {
  const sourceCharacters = Array.from(input.originalText).length;
  const translationCharacters = Array.from(input.translatedText).length;
  const ratio = sourceCharacters === 0
    ? 0
    : round(translationCharacters / sourceCharacters, 3);
  const quality: TranslationQualityLogFields = {
    trace_id: input.traceId,
    source_language: input.sourceLanguage,
    target_language: input.targetLanguage,
    source_characters: sourceCharacters,
    translation_characters: translationCharacters,
    translation_source_ratio: ratio,
    original_token_count: input.originalConfidence?.tokenCount ?? 0,
    original_confidence_mean: input.originalConfidence?.mean ?? null,
    original_confidence_min: input.originalConfidence?.min ?? null,
  };
  const repeated = findRepeatedTranslation(input.translatedText, input.targetLanguage);
  return {
    quality,
    ...(repeated
      ? {
          anomaly: {
            trace_id: input.traceId,
            source_language: input.sourceLanguage,
            target_language: input.targetLanguage,
            source_characters: sourceCharacters,
            translation_characters: translationCharacters,
            translation_source_ratio: ratio,
            max_repeat_count: repeated.maxRepeatCount,
            ngram_length: repeated.ngramLength,
          },
        }
      : {}),
  };
}
