import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ConcurrencyLimitsResponse,
  SonioxModel,
  TtsModel,
} from "@soniox/node";

import { ConfigError } from "../src/config.js";
import { ApplicationError } from "../src/domain/application-error.js";
import {
  SonioxCapacityGate,
  SonioxSttFactory,
  SonioxUsageReconciliationQueue,
  SonioxUsageReconciler,
  hasSonioxCapacity,
  verifySonioxConfiguration,
} from "../src/soniox/control.js";

void test("STTは認識精度を優先してendpoint調整をSoniox既定値へ委ねる", () => {
  let received: Record<string, unknown> | undefined;
  const factory = new SonioxSttFactory(
    {
      realtime: {
        stt: (input: Record<string, unknown>) => {
          received = input;
          return {};
        },
      },
    } as never,
    "stt-rt-v5",
  );

  factory.create("ja-ko", "request-ref", []);

  assert.ok(received);
  assert.equal(received.enable_endpoint_detection, true);
  assert.equal("max_endpoint_delay_ms" in received, false);
  assert.equal("endpoint_latency_adjustment_level" in received, false);
  assert.equal("endpoint_sensitivity" in received, false);
});

void test("3言語ペアをSonioxの双方向翻訳設定へ正しく変換する", () => {
  const received: Record<string, unknown>[] = [];
  const factory = new SonioxSttFactory(
    {
      realtime: {
        stt: (input: Record<string, unknown>) => {
          received.push(input);
          return {};
        },
      },
    } as never,
    "stt-rt-v5",
  );
  const cases = [
    ["ja-ko", "ja", "ko"],
    ["ja-en", "ja", "en"],
    ["ko-en", "ko", "en"],
  ] as const;

  for (const [pair] of cases) factory.create(pair, `request-ref-${pair}`, []);

  for (const [index, [pair, languageA, languageB]] of cases.entries()) {
    const input = received[index];
    assert.ok(input);
    assert.deepEqual(input.language_hints, [languageA, languageB], pair);
    assert.deepEqual(input.translation, {
      type: "two_way",
      language_a: languageA,
      language_b: languageB,
    }, pair);
  }
});

void test("セッション開始時に固定した翻訳用語だけをSTT contextへ渡す", () => {
  const received: Record<string, unknown>[] = [];
  const factory = new SonioxSttFactory(
    {
      realtime: {
        stt: (input: Record<string, unknown>) => {
          received.push(input);
          return {};
        },
      },
    } as never,
    "stt-rt-v5",
  );

  const first = factory.create("ja-en", "request-1", [
    { source: "技術室", target: "technology room" },
  ]);
  factory.create("ja-en", "request-2", []);

  assert.deepEqual(received[0]?.context, {
    translation_terms: [{ source: "技術室", target: "technology room" }],
  });
  assert.equal(
    first.initialTextCharacterCount,
    Array.from(JSON.stringify(received[0]?.context)).length,
  );
  assert.equal("context" in (received[1] ?? {}), false);
});

void test("構造化会話contextを言語ペアごとに送り、用語をASR termsへ転用しない", () => {
  const received: Record<string, unknown>[] = [];
  const factory = new SonioxSttFactory(
    {
      realtime: {
        stt: (input: Record<string, unknown>) => {
          received.push(input);
          return {};
        },
      },
    } as never,
    "stt-rt-v5",
    true,
  );

  const created = factory.create("ja-ko", "request-1", [
    { source: "塾", target: "학원" },
  ]);

  assert.deepEqual(received[0]?.context, {
    general: [
      { key: "setting", value: "Private Discord voice conversation between friends" },
      {
        key: "purpose",
        value: "Real-time two-way transcription and translation between Japanese and Korean",
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
    ],
    translation_terms: [{ source: "塾", target: "학원" }],
  });
  assert.equal("terms" in (received[0]?.context as Record<string, unknown>), false);
  assert.equal(
    created.initialTextCharacterCount,
    Array.from(JSON.stringify(received[0]?.context)).length,
  );
});

function withTestDeadline<T>(operation: Promise<T>, timeoutMs = 50): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test operation did not settle")), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error
          ? error
          : new Error("test operation failed", { cause: error }));
      },
    );
  });
}

function limits(
  currentStt: number,
  sttLimit: number | null,
  currentTts: number,
  ttsLimit: number | null,
): ConcurrencyLimitsResponse {
  return {
    project: {
      current: {
        transcribe_concurrent: currentStt,
        tts_concurrent: currentTts,
      },
      limits: {
        transcribe_concurrent: sttLimit,
        tts_concurrent: ttsLimit,
      },
    },
    organization: {
      current: {
        transcribe_concurrent: currentStt,
        tts_concurrent: currentTts,
      },
      limits: {
        transcribe_concurrent: sttLimit,
        tts_concurrent: ttsLimit,
      },
    },
  };
}

void test("projectとorganizationの両方にSTT 2本・TTS 1本の空きが必要", () => {
  assert.equal(hasSonioxCapacity(limits(8, 10, 4, 5), 2, 1), true);
  assert.equal(hasSonioxCapacity(limits(9, 10, 4, 5), 2, 1), false);
  assert.equal(hasSonioxCapacity(limits(999, null, 999, null), 2, 1), true);

  const organizationFull = limits(0, 10, 0, 5);
  organizationFull.organization.current.tts_concurrent = 5;
  assert.equal(hasSonioxCapacity(organizationFull, 2, 1), false);
});

void test("容量API失敗や空き不足は推測で開始せず安定コードへ変換する", async () => {
  const full = new SonioxCapacityGate({
    concurrencyLimits: { get: () => Promise.resolve(limits(9, 10, 0, 5)) },
  });
  await assert.rejects(
    full.assertCanStart({ sttStreams: 2, ttsStreams: 1, at: new Date() }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "SONIOX_CAPACITY_UNAVAILABLE",
  );

  const unavailable = new SonioxCapacityGate({
    concurrencyLimits: { get: () => Promise.reject(new Error("network")) },
  });
  await assert.rejects(
    unavailable.assertCanStart({ sttStreams: 2, ttsStreams: 1, at: new Date() }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "SONIOX_CAPACITY_UNAVAILABLE",
  );

  const timedOut = new SonioxCapacityGate({
    concurrencyLimits: {
      get: () => new Promise(() => undefined),
    },
  }, 5);
  await assert.rejects(
    withTestDeadline(
      timedOut.assertCanStart({ sttStreams: 2, ttsStreams: 1, at: new Date() }),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "SONIOX_CAPACITY_UNAVAILABLE",
  );
});

void test("usage logsの不透明request refだけを正確なmicroUSDへ照合する", async () => {
  const reconciled: { requestRef: string; cost: number }[] = [];
  let markedAt: Date | undefined;
  const reconciler = new SonioxUsageReconciler(
    {
      usageLogs: {
        list: () => Promise.resolve({
          // AsyncIterable is the public pagination contract; this fixture has one in-memory page.
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            yield {
              client_reference_id: "known-ref",
              cost_usd: "0.1234567",
            };
            yield {
              client_reference_id: "unknown-ref",
              cost_usd: "99.0",
            };
          },
        }),
      },
    },
    {
      getLastReconciledAt: () => undefined,
      hasProviderRequest: (requestRef) => requestRef === "known-ref",
      reconcileProviderRequest: (requestRef, cost) => {
        reconciled.push({ requestRef, cost });
      },
      markReconciled: (at) => {
        markedAt = at;
      },
    },
  );
  const at = new Date("2026-08-15T03:00:00Z");

  await reconciler.reconcile(at);

  assert.deepEqual(reconciled, [{ requestRef: "known-ref", cost: 123_457 }]);
  assert.equal(markedAt?.toISOString(), at.toISOString());
});

void test("実行中の定期照合があってもセッション終了時刻までの照合を直列実行する", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const queue = new SonioxUsageReconciliationQueue(
    {
      reconcile: async (at) => {
        calls.push(at.toISOString());
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    },
    () => assert.fail("照合は失敗しません"),
  );
  const intervalAt = new Date("2026-08-15T03:00:00Z");
  const sessionEndedAt = new Date("2026-08-15T03:00:01Z");

  const interval = queue.schedule(intervalAt);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sessionEnd = queue.schedule(sessionEndedAt);
  assert.deepEqual(calls, [intervalAt.toISOString()]);

  releaseFirst?.();
  await Promise.all([interval, sessionEnd, queue.wait()]);
  assert.deepEqual(calls, [intervalAt.toISOString(), sessionEndedAt.toISOString()]);
});

void test("定期照合は最新1件へ集約しセッション終了照合を先に実行する", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const queue = new SonioxUsageReconciliationQueue(
    {
      reconcile: async (at) => {
        calls.push(at.toISOString());
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    },
    () => assert.fail("照合は失敗しません"),
  );
  const runningAt = new Date("2026-08-15T03:00:00Z");
  const stalePeriodicAt = new Date("2026-08-15T03:00:01Z");
  const latestPeriodicAt = new Date("2026-08-15T03:00:02Z");
  const sessionEndedAt = new Date("2026-08-15T03:00:03Z");

  const running = queue.schedulePeriodic(runningAt);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stalePeriodic = queue.schedulePeriodic(stalePeriodicAt);
  const latestPeriodic = queue.schedulePeriodic(latestPeriodicAt);
  const sessionEnd = queue.schedule(sessionEndedAt);

  releaseFirst?.();
  await Promise.all([
    running,
    stalePeriodic,
    latestPeriodic,
    sessionEnd,
    queue.wait(),
  ]);
  assert.deepEqual(calls, [
    runningAt.toISOString(),
    sessionEndedAt.toISOString(),
    latestPeriodicAt.toISOString(),
  ]);
});

void test("TTSモデルの対応言語、voice、無音短縮、速度範囲が不正なら起動前検証で拒否する", async () => {
  const sttModel: SonioxModel = {
    id: "stt-rt-v4",
    aliased_model_id: null,
    name: "Realtime STT",
    context_version: 1,
    transcription_mode: "real_time",
    languages: ["ja", "ko", "en"].map((code) => ({ code, name: code })),
    supports_language_hints_strict: true,
    supports_max_endpoint_delay: true,
    supports_endpoint_sensitivity: true,
    supports_endpoint_latency_adjustment: true,
    endpoint_latency_adjustment_max_level: 1,
    translation_targets: [],
    two_way_translation_pairs: [],
    one_way_translation: null,
    two_way_translation: "all_languages",
  };
  const ttsModel: TtsModel = {
    id: "tts-rt-v2",
    aliased_model_id: null,
    name: "Realtime TTS",
    languages: [{ code: "en", name: "English" }],
    voices: [{ id: "shared-voice", description: "Test", gender: "neutral" }],
    supports_speed_adjustment: true,
    speed_min: 1.2,
    speed_max: 1.3,
    supports_silence_reduction: false,
  };

  await assert.rejects(
    verifySonioxConfiguration(
      {
        models: { list: () => Promise.resolve([sttModel]) },
        tts: { listModels: () => Promise.resolve([ttsModel]) },
      },
      {
        sttModel: "stt-rt-v4",
        ttsModel: "tts-rt-v2",
        ttsSpeed: 1.15,
        voices: { ja: "Mima", ko: "shared-voice", en: "shared-voice" },
      },
    ),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.issues.includes("TTS modelがjaに未対応です") &&
      error.issues.includes("TTS modelがkoに未対応です") &&
      error.issues.includes("TTS modelが無音短縮に未対応です") &&
      error.issues.includes(
        "SONIOX_TTS_SPEED「1.15」はTTS modelの対応範囲1.2〜1.3外です",
      ) &&
      error.issues.includes(
        "TTS modelの速度調整範囲1.2〜1.3が公開範囲0.7〜1.3を満たしていません",
      ) &&
      error.issues.includes("SONIOX_VOICE_JA「Mima」を利用できません"),
  );
});

void test("モデル事前確認と利用ログ照合は応答期限を超えて待ち続けない", { timeout: 250 }, async () => {
  const pending = <T>(): Promise<T> => new Promise(() => undefined);

  await assert.rejects(
    withTestDeadline(
      verifySonioxConfiguration(
        {
          models: { list: () => pending() },
          tts: { listModels: () => pending() },
        },
        {
          sttModel: "stt-rt-v4",
          ttsModel: "tts-rt-v2",
          ttsSpeed: 1.15,
          voices: { ja: "voice", ko: "voice", en: "voice" },
        },
        5,
      ),
    ),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );

  const reconciler = new SonioxUsageReconciler(
    {
      usageLogs: {
        list: () => pending(),
      },
    },
    {
      getLastReconciledAt: () => undefined,
      hasProviderRequest: () => false,
      reconcileProviderRequest: () => undefined,
      markReconciled: () => assert.fail("timeout時に照合成功時刻を更新してはいけません"),
    },
    5,
  );
  await assert.rejects(
    withTestDeadline(reconciler.reconcile(new Date("2026-08-15T03:00:00Z"))),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );

  const stalledIteratorReconciler = new SonioxUsageReconciler(
    {
      usageLogs: {
        list: () => Promise.resolve({
          async *[Symbol.asyncIterator]() {
            await new Promise<void>(() => undefined);
            yield { client_reference_id: "never", cost_usd: "0" };
          },
        }),
      },
    },
    {
      getLastReconciledAt: () => undefined,
      hasProviderRequest: () => false,
      reconcileProviderRequest: () => undefined,
      markReconciled: () => assert.fail("iterator timeout時に照合成功時刻を更新してはいけません"),
    },
    5,
  );
  await assert.rejects(
    stalledIteratorReconciler.reconcile(new Date("2026-08-15T03:00:00Z")),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
});
