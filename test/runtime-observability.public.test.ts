import assert from "node:assert/strict";
import { test } from "node:test";

import { safeDiscordRateLimitFields } from "../src/observability/discord-rate-limit.js";
import { RuntimeHealthSampler } from "../src/observability/runtime-health.js";

void test("Discord rate-limitログは制御値だけを残し、routeやIDを除外する", () => {
  const fields = safeDiscordRateLimitFields({
    global: false,
    hash: "secret-bucket-hash",
    limit: 5,
    majorParameter: "123456789012345678",
    method: "PATCH",
    retryAfter: 1_234,
    route: "/channels/:id/messages/:id",
    scope: "shared",
    sublimitTimeout: 500,
    timeToReset: 1_000,
    url: "https://discord.com/api/v10/channels/123456789012345678/messages/1",
  });

  assert.deepEqual(fields, {
    global: false,
    limit: 5,
    method: "PATCH",
    retry_after_ms: 1_234,
    scope: "shared",
    sublimit_timeout_ms: 500,
    time_to_reset_ms: 1_000,
  });
  assert.doesNotMatch(JSON.stringify(fields), /secret|123456789012345678|channels/u);
});

void test("30秒区間のSTT到着間隔、event-loop、CPU、memoryを本文なしで集計する", () => {
  let now = 0;
  let cpu = { user: 0, system: 0 };
  let enabled = 0;
  let disabled = 0;
  let resets = 0;
  const sampler = new RuntimeHealthSampler({
    now: () => now,
    cpuUsage: () => cpu,
    memoryUsage: () => ({
      rss: 400,
      heapTotal: 300,
      heapUsed: 200,
      external: 100,
      arrayBuffers: 50,
    }),
    eventLoop: {
      enable: () => { enabled += 1; },
      disable: () => { disabled += 1; },
      reset: () => { resets += 1; },
      percentile: () => 5_000_000,
      get max() { return 12_000_000; },
    },
  });

  sampler.recordSttResult(100);
  sampler.recordSttResult(160);
  sampler.recordSttResult(260);
  now = 1_000;
  cpu = { user: 600_000, system: 200_000 };

  assert.deepEqual(sampler.sample(), {
    event_loop_p95_ms: 5,
    event_loop_max_ms: 12,
    process_cpu_pct: 80,
    rss_bytes: 400,
    heap_used_bytes: 200,
    stt_result_count: 3,
    stt_result_gap_p95_ms: 100,
    stt_result_gap_max_ms: 100,
  });
  assert.equal(enabled, 1);
  assert.equal(resets, 1);
  sampler.stop();
  assert.equal(disabled, 1);
});
