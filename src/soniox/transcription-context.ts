import type { TranscriptionContext } from "@soniox/node";

import type { TranslationTerm } from "../config/translation-terms.js";
import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";

export const sonioxContextCharacterLimit = 10_000;

const languageNames: Readonly<Record<Language, string>> = {
  ja: "Japanese",
  ko: "Korean",
  en: "English",
};

export type BuiltSonioxTranscriptionContext = {
  context?: TranscriptionContext;
  characterCount: number;
};

export type SonioxRecognitionTermScope = "source" | "source_target";

function generalContext(pair: LanguagePair): NonNullable<TranscriptionContext["general"]> {
  const [languageA, languageB] = languagesForPair(pair);
  return [
    {
      key: "setting",
      value: "Private Discord voice conversation between friends",
    },
    {
      key: "purpose",
      value: `Real-time two-way transcription and translation between ${languageNames[languageA]} and ${languageNames[languageB]}`,
    },
    {
      key: "topics",
      value: "Daily life, school and university, food, games, music, and internet culture",
    },
    {
      key: "language_behavior",
      value: "Participants may quote or practice either language and switch languages; transcribe the language actually spoken",
    },
    {
      key: "translation_style",
      value: "Natural casual conversation; preserve negation, subject, direction, beneficiary, proper nouns, and idiomatic meaning",
    },
  ];
}

function recognitionTerms(
  translationTerms: readonly TranslationTerm[],
  scope: SonioxRecognitionTermScope,
): string[] {
  const terms = new Set<string>();
  for (const translationTerm of translationTerms) {
    terms.add(translationTerm.source);
    if (scope === "source_target") terms.add(translationTerm.target);
  }
  return [...terms];
}

export function buildSonioxTranscriptionContext(
  pair: LanguagePair,
  translationTerms: readonly TranslationTerm[],
  includeGeneral: boolean,
  includeRecognitionTerms = includeGeneral,
  recognitionTermScope: SonioxRecognitionTermScope = "source_target",
): BuiltSonioxTranscriptionContext {
  const context: TranscriptionContext = {
    ...(includeGeneral ? { general: generalContext(pair) } : {}),
    ...(includeRecognitionTerms && translationTerms.length > 0
      ? { terms: recognitionTerms(translationTerms, recognitionTermScope) }
      : {}),
    ...(translationTerms.length > 0
      ? { translation_terms: translationTerms.map((entry) => ({ ...entry })) }
      : {}),
  };
  if (Object.keys(context).length === 0) return { characterCount: 0 };
  return {
    context,
    characterCount: Array.from(JSON.stringify(context)).length,
  };
}

export function assertSonioxContextFits(
  pair: LanguagePair,
  translationTerms: readonly TranslationTerm[],
  includeGeneralContext: boolean,
): void {
  const { characterCount } = buildSonioxTranscriptionContext(
    pair,
    translationTerms,
    includeGeneralContext,
  );
  if (characterCount > sonioxContextCharacterLimit) {
    throw new Error(
      `${pair}: Soniox contextの${sonioxContextCharacterLimit.toLocaleString("en-US")}文字上限を超えています`,
    );
  }
}
