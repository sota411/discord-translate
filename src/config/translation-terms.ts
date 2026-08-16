import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  languagePairs,
  type LanguagePair,
} from "../domain/language-pair.js";

export type TranslationTerm = {
  source: string;
  target: string;
};

export type TranslationTerms = Readonly<Record<LanguagePair, readonly TranslationTerm[]>>;

const termSchema = z.object({
  source: z.string().refine((value) => value.trim().length > 0, "sourceは空にできません"),
  target: z.string().refine((value) => value.trim().length > 0, "targetは空にできません"),
}).strict();

const termsSchema = z.object({
  "ja-ko": z.array(termSchema),
  "ja-en": z.array(termSchema),
  "ko-en": z.array(termSchema),
}).strict();

export function parseTranslationTerms(json: string): TranslationTerms {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error("翻訳用語ファイルが有効なJSONではありません", { cause: error });
  }
  const result = termsSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`翻訳用語ファイルが不正です: ${issues}`);
  }

  for (const pair of languagePairs) {
    const entries = result.data[pair];
    const sources = new Set<string>();
    for (const entry of entries) {
      if (sources.has(entry.source)) {
        throw new Error(`${pair}: source「${entry.source}」が重複しています`);
      }
      sources.add(entry.source);
    }
    if (Array.from(JSON.stringify(entries)).length > 10_000) {
      throw new Error(`${pair}: Soniox contextの10,000文字上限を超えています`);
    }
  }
  return result.data;
}

export function loadTranslationTerms(filePath: string | undefined): TranslationTerms {
  if (!filePath) {
    return { "ja-ko": [], "ja-en": [], "ko-en": [] };
  }
  try {
    return parseTranslationTerms(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`翻訳用語ファイルを読み込めません: ${filePath}${reason}`, {
      cause: error,
    });
  }
}
