import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSttEvaluationReport,
  parseSttEvaluationManifest,
  parseSttEvaluationObservations,
  sttEvaluationProfileConfigurations,
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
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 300, has_text: true },
          { kind: "finalized", reason: "speaking_end", latency_ms: 500, has_text: true },
        ],
        cpu_percent: 10,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        case_id: "ko-noise",
        profile: "baseline",
        transcript: "안녕",
        segments: ["안녕"],
        recognized_languages: ["ko"],
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 400, has_text: true },
        ],
        cpu_percent: 12,
        decoded_packet_count: 8,
        dropped_packet_count: 2,
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        case_id: "code-switch",
        profile: "baseline",
        transcript: "今日は안녕",
        segments: ["今日は안녕"],
        recognized_languages: ["ja"],
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 450, has_text: true },
        ],
        cpu_percent: 11,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        case_id: "ja-clean-term",
        profile: "context",
        transcript: "今日は猫",
        segments: ["今日は猫"],
        recognized_languages: ["ja"],
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 300, has_text: true },
        ],
        cpu_percent: 10,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.context,
      },
      {
        case_id: "ko-noise",
        profile: "context",
        transcript: "안녕",
        segments: ["안녕"],
        recognized_languages: ["ko"],
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 400, has_text: true },
        ],
        cpu_percent: 12,
        decoded_packet_count: 8,
        dropped_packet_count: 2,
        configuration: sttEvaluationProfileConfigurations.context,
      },
      {
        case_id: "code-switch",
        profile: "context",
        transcript: "今日は失敗",
        segments: ["今日は失敗"],
        recognized_languages: ["ja"],
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 450, has_text: true },
        ],
        cpu_percent: 11,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.context,
      },
      {
        case_id: "ja-clean-term",
        profile: "context_endpoint",
        transcript: "今日は猫",
        segments: ["今日は猫"],
        recognized_languages: ["ja"],
        finalizations: [
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 350, has_text: true },
        ],
        cpu_percent: 10.5,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.context_endpoint,
      },
      {
        case_id: "ko-noise",
        profile: "context_endpoint",
        transcript: "안녕",
        segments: ["안녕"],
        recognized_languages: ["ko"],
        finalizations: [
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 450, has_text: true },
        ],
        cpu_percent: 12.5,
        decoded_packet_count: 8,
        dropped_packet_count: 2,
        configuration: sttEvaluationProfileConfigurations.context_endpoint,
      },
      {
        case_id: "code-switch",
        profile: "context_endpoint",
        transcript: "今日は안녕",
        segments: ["今日は안녕"],
        recognized_languages: ["ja", "ko"],
        finalizations: [
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 600, has_text: true },
        ],
        cpu_percent: 11.5,
        decoded_packet_count: 10,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.context_endpoint,
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
  assert.equal(report.profiles.baseline.latency_ms.mean, 412.5);
  assert.equal(report.profiles.baseline.latency_ms.p50, 400);
  assert.equal(report.profiles.baseline.latency_ms.p95, 500);
  assert.equal(report.profiles.baseline.finalization.manual_fallback_count, 4);
  assert.ok(report.profiles.context_endpoint);
  assert.ok(report.comparisons.context_endpoint);
  assert.ok(report.comparisons.context);
  assert.equal(report.profiles.context_endpoint.finalization.soniox_endpoint_ratio, 1);
  assert.equal(report.profiles.baseline.packets.dropped_mean, 2 / 3);
  assert.equal(report.profiles.baseline.cases[1]?.dropped_packet_count, 2);
  assert.equal(report.profiles.baseline.code_switch_cer, 0);
  assert.equal(report.profiles.context_endpoint.cer, 0);
  assert.equal(report.profiles.context_endpoint.key_term_recall, 1);
  assert.equal(report.profiles.context_endpoint.language_recall, 1);
  assert.equal(report.comparisons.context_endpoint.cer_relative_improvement_percent, 100);
  assert.equal(report.comparisons.context_endpoint.p95_added_latency_ms, 100);
  assert.equal(report.comparisons.context_endpoint.code_switch_cer_point_change, 0);
  assert.equal(report.comparisons.context_endpoint.gates.overall_cer, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.key_terms, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.clean_cer, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.language_switching, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.latency, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.semantic_endpoint, "pass");
  assert.equal(report.comparisons.context_endpoint.gates.pi_runtime, "not_evaluated");
  assert.equal(report.comparisons.context.language_switch_recall_change, 0);
  const contextCodeSwitchCerChange = report.comparisons.context.code_switch_cer_point_change;
  assert.ok(contextCodeSwitchCerChange !== null && contextCodeSwitchCerChange > 0);
  assert.equal(report.comparisons.context.gates.language_switching, "fail");
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
      finalizations: [
        { kind: "finalized", reason: "speaking_end", latency_ms: 100, has_text: true },
      ],
      cpu_percent: 1,
      decoded_packet_count: 1,
      dropped_packet_count: 0,
      configuration: sttEvaluationProfileConfigurations.baseline,
      raw_audio: "must-not-be-accepted",
    }],
  };

  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify(invalid)),
    /raw_audio/u,
  );
});

void test("観測結果はprofileに対応する実効設定を必須とする", () => {
  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify({
      version: 1,
      results: [{
        case_id: "ja-clean-term",
        profile: "baseline",
        transcript: "今日は猫",
        segments: ["今日は猫"],
        recognized_languages: ["ja"],
        finalization_latencies_ms: [100],
        cpu_percent: 1,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
      }],
    })),
    /configuration/u,
  );
  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify({
      version: 1,
      results: [{
        case_id: "ja-clean-term",
        profile: "baseline",
        transcript: "今日は猫",
        segments: ["今日は猫"],
        recognized_languages: ["ja"],
        finalizations: [
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 100, has_text: true },
        ],
        cpu_percent: 1,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.endpoint,
      }],
    })),
    /profile.*実効設定/u,
  );
});

void test("本文のないendpointでSoniox中心の採用比率を水増ししない", () => {
  const sourceManifest = JSON.parse(manifestJson) as { cases: unknown[] };
  const manifest = parseSttEvaluationManifest(JSON.stringify({
    ...sourceManifest,
    cases: sourceManifest.cases.slice(0, 1),
  }));
  const common = {
    case_id: "ja-clean-term",
    transcript: "今日は猫",
    segments: ["今日は猫"],
    recognized_languages: ["ja"],
    cpu_percent: 1,
    decoded_packet_count: 1,
    dropped_packet_count: 0,
  };
  const observations = parseSttEvaluationObservations(JSON.stringify({
    version: 1,
    results: [
      {
        ...common,
        profile: "baseline",
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 100, has_text: true },
        ],
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        ...common,
        profile: "endpoint",
        finalizations: [
          { kind: "finalized", reason: "speaking_end", latency_ms: 100, has_text: true },
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 120, has_text: false },
          { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 140, has_text: false },
        ],
        configuration: sttEvaluationProfileConfigurations.endpoint,
      },
    ],
  }));

  const report = createSttEvaluationReport(manifest, observations);

  assert.equal(report.profiles.endpoint?.finalization.soniox_endpoint_ratio, 0);
  assert.equal(report.comparisons.endpoint?.gates.semantic_endpoint, "fail");
  assert.deepEqual(report.profiles.endpoint.cases[0]?.finalizations, [
    { kind: "finalized", reason: "speaking_end", latency_ms: 100, has_text: true },
    { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 120, has_text: false },
    { kind: "endpoint", reason: "soniox_endpoint", latency_ms: 140, has_text: false },
  ]);
});

void test("追跡する人工音声レポートは本文・正解文・API keyを含まない", () => {
  const report = readFileSync("docs/evaluation/stt-artificial-2026-08-25.json", "utf8");

  assert.doesNotMatch(
    report,
    /"(?:transcript|reference|translation_terms|api_key|raw_audio)"/u,
  );
  assert.match(report, /"manifest_sha256": "[a-f0-9]{64}"/u);
});
