import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ConcurrencyLimitsResponse,
  SonioxModel,
  TtsModel,
} from "@soniox/node";

import { ApplicationError } from "../src/domain/application-error.js";
import {
  SonioxCapacityGate,
  SonioxUsageReconciliationQueue,
  SonioxUsageReconciler,
  hasSonioxCapacity,
  verifySonioxConfiguration,
} from "../src/soniox/control.js";

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

void test("TTSモデルが対象3言語を満たさない場合は起動前検証で拒否する", async () => {
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
    endpoint_latency_adjustment_max_level: 3,
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
    speed_min: 0.7,
    speed_max: 1.3,
    supports_silence_reduction: true,
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
        voices: { ja: "shared-voice", ko: "shared-voice", en: "shared-voice" },
      },
    ),
    /TTS modelがjaに未対応です.*TTS modelがkoに未対応です/s,
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
