export const languagePairs = ["ja-ko", "ja-en", "ko-en"] as const;

export type Language = "ja" | "ko" | "en";
export type LanguagePair = (typeof languagePairs)[number];

export const languagePairLabels: Readonly<Record<LanguagePair, string>> = {
  "ja-ko": "日本語 ⇄ 韓国語",
  "ja-en": "日本語 ⇄ 英語",
  "ko-en": "韓国語 ⇄ 英語",
};

export function languagesForPair(pair: LanguagePair): readonly [Language, Language] {
  const [languageA, languageB] = pair.split("-") as [Language, Language];
  return [languageA, languageB];
}

export function isLanguagePair(value: string): value is LanguagePair {
  return languagePairs.includes(value as LanguagePair);
}
