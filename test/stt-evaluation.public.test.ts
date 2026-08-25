import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSttEvaluationReport,
  parseSttEvaluationManifest,
  parseSttEvaluationObservations,
} from "../src/evaluation/stt-evaluation.js";

const manifestJson = JSON.stringify({
  version: 1,
  pair: "ja-ko",
  audio: {
    format: "pcm_s16le",
    sample_rate: 48_000,
    channels: 1,
  },
  cases: [
    {
      id: "ja-clean-term",
      audio: "audio/ja-clean-term.pcm",
      reference: "今日は猫",
      language: "ja",
      tags: ["clean", "game-term"],
      key_terms: ["猫"],
      expected_languages: ["ja"],
      expected_segments: 1,
      packet_trace: "audio/ja-clean-term.packets.json",
      translation_terms: [{ source: "猫", target: "고양이" }],
    },
    {
      id: "ko-noise",
      audio: "audio/ko-noise.pcm",
      reference: "안녕",
      language: "ko",
      tags: ["noise"],
      key_terms: [],
      expected_languages: ["ko"],
      expected_segments: 1,
      packet_trace: "audio/ko-noise.packets.json",
      translation_terms: [],
    },
    {
      id: "code-switch",
      audio: "audio/code-switch.pcm",
      reference: "今日は안녕",
      language: "ja",
      tags: ["clean", "code-switch"],
      key_terms: [],
      expected_languages: ["ja", "ko"],
      expected_segments: 1,
      packet_trace: "audio/code-switch.packets.json",
      translation_terms: [],
    },
  ],
});

void test("STT評価manifestは同一音声A〜Dに必要な正解・区間・用語を検証する", () => {
  const manifest = parseSttEvaluationManifest(manifestJson);

  assert.equal(manifest.cases.length, 3);
  assert.equal(manifest.cases[0]?.translation_terms[0]?.target, "고양이");
  assert.throws(
    () => parseSttEvaluationManifest(JSON.stringify({
      ...JSON.parse(manifestJson) as object,
      cases: [
        (JSON.parse(manifestJson) as { cases: unknown[] }).cases[0],
        (JSON.parse(manifestJson) as { cases: unknown[] }).cases[0],
      ],
    })),
    /case id.*重複/u,
  );
  assert.throws(
    () => parseSttEvaluationManifest(JSON.stringify({
      ...JSON.parse(manifestJson) as object,
      cases: [{
        ...(JSON.parse(manifestJson) as { cases: Record<string, unknown>[] }).cases[0],
        packet_trace: "",
      }],
    })),
    /packet_trace/u,
  );
});

void test("同一音声の結果からCER・固有名詞再現率・分割数・p50/p95を比較する", () => {
  const manifest = parseSttEvaluationManifest(manifestJson);
  const observations = parseSttEvaluationObservations(JSON.stringify({
    version: 1,
    results: [
      {
        case_id: "ja-clean-term",
        profile: "baseline",
        transcript: "今日は犬",
        segments: ["今日は", "犬"],
        recognized_languages: ["ja"],
        finalization_latencies_ms: [300, 500],
        cpu_percent: 10,
      },
      {
        case_id: "ko-noise",
        profile: "baseline",
        transcript: "안녕",
        segments: ["안녕"],
        recognized_languages: ["ko"],
        finalization_latencies_ms: [400],
        cpu_percent: 12,
      },
      {
        case_id: "code-switch",
        profile: "baseline",
        transcript: "今日は안녕",
        segments: ["今日は안녕"],
        recognized_languages: ["ja"],
        finalization_latencies_ms: [450],
        cpu_percent: 11,
      },
      {
        case_id: "ja-clean-term",
        profile: "context_endpoint",
        transcript: "今日は猫",
        segments: ["今日は猫"],
        recognized_languages: ["ja"],
        finalization_latencies_ms: [350],
        cpu_percent: 10.5,
      },
      {
        case_id: "ko-noise",
        profile: "context_endpoint",
        transcript: "안녕",
        segments: ["안녕"],
        recognized_languages: ["ko"],
        finalization_latencies_ms: [450],
        cpu_percent: 12.5,
      },
      {
        case_id: "code-switch",
        profile: "context_endpoint",
        transcript: "今日は안녕",
        segments: ["今日は안녕"],
        recognized_languages: ["ja", "ko"],
        finalization_latencies_ms: [600],
        cpu_percent: 11.5,
      },
    ],
  }));

  const report = createSttEvaluationReport(
    manifest,
    observations,
    new Date("2026-08-25T00:00:00Z"),
  );

  assert.deepEqual(report.profile_mapping, {
    A: "baseline",
    B: "context",
    C: "endpoint",
    D: "context_endpoint",
  });
  assert.equal(report.profiles.baseline?.cer, 1 / 11);
  assert.equal(report.profiles.baseline.key_term_recall, 0);
  assert.equal(report.profiles.baseline.unnatural_split_count, 1);
  assert.equal(report.profiles.baseline.latency_ms.p50, 400);
  assert.equal(report.profiles.baseline.latency_ms.p95, 500);
  assert.equal(report.profiles.context_endpoint?.cer, 0);
  assert.equal(report.profiles.context_endpoint.key_term_recall, 1);
  assert.equal(report.profiles.context_endpoint.language_recall, 1);
  assert.equal(report.comparisons.context_endpoint?.cer_relative_improvement_percent, 100);
  assert.equal(report.comparisons.context_endpoint.p95_added_latency_ms, 100);
  assert.equal(report.comparisons.context_endpoint.gates.overall_cer, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.key_terms, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.clean_cer, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.language_switching, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.latency, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.pi_runtime, "not_evaluated");
  assert.equal(report.preprocessing.decision, "not_adopted");
});

void test("観測結果は未知case・重複profile・本文以外の余分なfieldをFail Fastで拒否する", () => {
  const invalid = {
    version: 1,
    results: [{
      case_id: "unknown",
      profile: "baseline",
      transcript: "秘密",
      segments: ["秘密"],
      recognized_languages: ["ja"],
      finalization_latencies_ms: [100],
      cpu_percent: 1,
      raw_audio: "must-not-be-accepted",
    }],
  };

  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify(invalid)),
    /raw_audio/u,
  );
});
