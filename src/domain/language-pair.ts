export const languagePairs = ["ja-ko", "ja-en", "ko-en"] as const;

export type Language = "ja" | "ko" | "en";
export type LanguagePair = (typeof languagePairs)[number];

export const languagePairLabels: Readonly<Record<LanguagePair, string>> = {
  "ja-ko": "JA ⇄ KO",
  "ja-en": "JA ⇄ EN",
  "ko-en": "KO ⇄ EN",
};

export function languagesForPair(pair: LanguagePair): readonly [Language, Language] {
  const [languageA, languageB] = pair.split("-") as [Language, Language];
  return [languageA, languageB];
}

export function isLanguagePair(value: string): value is LanguagePair {
  return languagePairs.includes(value as LanguagePair);
}
