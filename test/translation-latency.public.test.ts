import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTranslationLatencyRecorder,
  type TranslationLatencyLogFields,
} from "../src/observability/translation-latency.js";

void test("発話終了から各翻訳段階までの時間だけを同じtrace IDで記録する", () => {
  const records: TranslationLatencyLogFields[] = [];
  const times = [1_000, 1_350, 1_420, 1_800];
  const recorder = createTranslationLatencyRecorder(
    (fields) => records.push(fields),
    () => times.shift() ?? assert.fail("予期しない時刻参照です"),
  );

  recorder.start("trace-1", 800);
  recorder.mark("trace-1", "caption_posted");
  recorder.mark("trace-1", "tts_first_audio");
  recorder.finish("trace-1");

  assert.deepEqual(records, [
    {
      trace_id: "trace-1",
      stage: "stt_endpoint",
      stage_ms: 200,
      total_ms: 200,
    },
    {
      trace_id: "trace-1",
      stage: "caption_posted",
      stage_ms: 350,
      total_ms: 550,
    },
    {
      trace_id: "trace-1",
      stage: "tts_first_audio",
      stage_ms: 70,
      total_ms: 620,
    },
    {
      trace_id: "trace-1",
      stage: "pipeline_finished",
      stage_ms: 380,
      total_ms: 1_000,
    },
  ]);
});

void test("分割TTSから同じ段階が複数回来ても最初の1回だけ記録する", () => {
  const records: TranslationLatencyLogFields[] = [];
  const times = [1_000, 1_100, 1_200];
  const recorder = createTranslationLatencyRecorder(
    (fields) => records.push(fields),
    () => times.shift() ?? assert.fail("予期しない時刻参照です"),
  );

  recorder.start("trace-split", 900);
  recorder.mark("trace-split", "tts_first_audio");
  recorder.mark("trace-split", "tts_first_audio");
  recorder.finish("trace-split");

  assert.deepEqual(records.map(({ stage, total_ms }) => ({ stage, total_ms })), [
    { stage: "stt_endpoint", total_ms: 100 },
    { stage: "tts_first_audio", total_ms: 200 },
    { stage: "pipeline_finished", total_ms: 300 },
  ]);
});

void test("FIFOの再生枠が空いた時刻を発話ごとに記録する", () => {
  const records: TranslationLatencyLogFields[] = [];
  const times = [1_000, 1_010, 1_020, 1_240, 1_300];
  const recorder = createTranslationLatencyRecorder(
    (fields) => records.push(fields),
    () => times.shift() ?? assert.fail("予期しない時刻参照です"),
  );

  recorder.start("trace-queue", 900);
  recorder.mark("trace-queue", "queue_enqueued");
  recorder.mark("trace-queue", "queue_started");
  recorder.mark("trace-queue", "playback_slot_ready");
  recorder.finish("trace-queue");

  assert.deepEqual(records.map(({ stage, total_ms }) => ({ stage, total_ms })), [
    { stage: "stt_endpoint", total_ms: 100 },
    { stage: "queue_enqueued", total_ms: 110 },
    { stage: "queue_started", total_ms: 120 },
    { stage: "playback_slot_ready", total_ms: 340 },
    { stage: "pipeline_finished", total_ms: 400 },
  ]);
});
