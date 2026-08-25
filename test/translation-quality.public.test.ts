import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTranslationQualityObservation,
  findRepeatedTranslation,
} from "../src/observability/translation-quality.js";
import { TranslationTokenAssembler } from "../src/translation/token-assembler.js";

void test("確定原文tokenだけからconfidenceを集計し、翻訳tokenは混ぜない", () => {
  const assembler = new TranslationTokenAssembler("ja-ko", {
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });
  assembler.accept({
    text: "こん",
    confidence: 0.8,
    is_final: true,
    language: "ja",
    translation_status: "original",
    start_ms: 0,
    end_ms: 200,
  });
  assembler.accept({
    text: "にちは",
    confidence: 0.6,
    is_final: true,
    language: "ja",
    translation_status: "original",
    start_ms: 200,
    end_ms: 500,
  });
  assembler.accept({
    text: "안녕하세요",
    confidence: 0.01,
    is_final: true,
    language: "ko",
    source_language: "ja",
    translation_status: "translation",
  });

  assert.deepEqual(assembler.flush(), {
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "こんにちは",
    translatedText: "안녕하세요",
    sourceDurationMs: 500,
    originalConfidence: {
      tokenCount: 2,
      mean: 0.7,
      min: 0.6,
    },
  });
});

void test("完成した翻訳本文から1〜4語の8回以上の連続反復だけを検知する", () => {
  assert.equal(findRepeatedTranslation("미스터 ".repeat(7), "ko"), undefined);
  assert.deepEqual(findRepeatedTranslation("미스터 ".repeat(8), "ko"), {
    maxRepeatCount: 8,
    ngramLength: 1,
  });
  assert.deepEqual(
    findRepeatedTranslation("very good ".repeat(9), "en"),
    { maxRepeatCount: 9, ngramLength: 2 },
  );
  assert.deepEqual(
    findRepeatedTranslation(`intro ${"very good ".repeat(8)}`, "en"),
    { maxRepeatCount: 8, ngramLength: 2 },
  );
  assert.deepEqual(
    findRepeatedTranslation("ｍｉｓｔｅｒ　".repeat(8), "en"),
    { maxRepeatCount: 8, ngramLength: 1 },
  );
});

void test("品質ログは本文や反復語句を含めず、匿名の数値だけを返す", () => {
  const observation = createTranslationQualityObservation({
    traceId: "trace-1",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "秘密の原文",
    translatedText: "미스터 ".repeat(8),
    originalConfidence: { tokenCount: 2, mean: 0.7, min: 0.6 },
  });

  assert.deepEqual(observation.quality, {
    trace_id: "trace-1",
    source_language: "ja",
    target_language: "ko",
    source_characters: 5,
    translation_characters: 32,
    translation_source_ratio: 6.4,
    original_token_count: 2,
    original_confidence_mean: 0.7,
    original_confidence_min: 0.6,
  });
  assert.deepEqual(observation.anomaly, {
    trace_id: "trace-1",
    source_language: "ja",
    target_language: "ko",
    source_characters: 5,
    translation_characters: 32,
    translation_source_ratio: 6.4,
    max_repeat_count: 8,
    ngram_length: 1,
  });
  assert.doesNotMatch(JSON.stringify(observation), /秘密|미스터/u);
});
