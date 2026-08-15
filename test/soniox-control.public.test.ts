import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConcurrencyLimitsResponse } from "@soniox/node";

import { ApplicationError } from "../src/domain/application-error.js";
import {
  SonioxCapacityGate,
  SonioxUsageReconciler,
  hasSonioxCapacity,
} from "../src/soniox/control.js";

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
