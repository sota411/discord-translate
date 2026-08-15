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
