import assert from "node:assert/strict";
import { test } from "node:test";

import { SttAudioMetricsAccumulator } from "../src/observability/stt-audio-metrics.js";

function pcm(samples: readonly number[]): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  for (const [index, sample] of samples.entries()) output.writeInt16LE(sample, index * 2);
  return output;
}

void test("発話単位のPCM品質・packet欠落・confidence・確定理由だけを集計してresetする", () => {
  const accumulator = new SttAudioMetricsAccumulator();
  accumulator.recordDecodedPacket(Buffer.alloc(960 * 2));
  accumulator.recordDecodedPacket(pcm([32_767, -32_768, 16_384, 0]));
  accumulator.recordDroppedPacket();

  const observation = accumulator.take({
    traceId: "opaque-trace",
    finalizeReason: "speaking_end",
    originalConfidence: { tokenCount: 2, mean: 0.75, min: 0.6 },
  });

  assert.equal(observation.trace_id, "opaque-trace");
  assert.equal(observation.rms_dbfs, -26.319);
  assert.equal(observation.peak_dbfs, 0);
  assert.equal(observation.clipped_sample_ratio, 0.002075);
  assert.equal(observation.near_silence_ratio, 0.5);
  assert.equal(observation.decoded_packet_count, 2);
  assert.equal(observation.dropped_packet_count, 1);
  assert.equal(observation.original_token_count, 2);
  assert.equal(observation.original_confidence_mean, 0.75);
  assert.equal(observation.original_confidence_min, 0.6);
  assert.equal(observation.finalize_reason, "speaking_end");
  assert.doesNotMatch(JSON.stringify(observation), /音声本文|user_id|guild_id/u);

  assert.deepEqual(accumulator.take({
    traceId: "next-trace",
    finalizeReason: "soniox_endpoint",
  }), {
    trace_id: "next-trace",
    rms_dbfs: null,
    peak_dbfs: null,
    clipped_sample_ratio: null,
    near_silence_ratio: null,
    decoded_packet_count: 0,
    dropped_packet_count: 0,
    original_token_count: 0,
    original_confidence_mean: null,
    original_confidence_min: null,
    finalize_reason: "soniox_endpoint",
  });
});
