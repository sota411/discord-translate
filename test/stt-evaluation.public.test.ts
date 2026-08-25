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
        audio_metrics: {
          rms_dbfs: -20,
          peak_dbfs: -2,
          clipped_sample_ratio: 0,
          near_silence_ratio: 0.1,
          original_token_count: 2,
          original_confidence_mean: 0.4,
          original_confidence_min: 0.3,
        },
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
        audio_metrics: {
          rms_dbfs: -15,
          peak_dbfs: -1,
          clipped_sample_ratio: 0,
          near_silence_ratio: 0,
          original_token_count: 2,
          original_confidence_mean: 0.9,
          original_confidence_min: 0.8,
        },
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
        audio_metrics: {
          rms_dbfs: -25,
          peak_dbfs: -5,
          clipped_sample_ratio: 0.1,
          near_silence_ratio: 0.2,
          original_token_count: 2,
          original_confidence_mean: 0.6,
          original_confidence_min: 0.5,
        },
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
  assert.equal(report.profiles.baseline.trial_count, 1);
  assert.equal(report.profiles.baseline.observation_count, 3);
  assert.ok(report.profiles.baseline.cases.every((entry) => entry.trial === 1));
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
  assert.equal(report.quality_analysis.status, "evaluated");
  assert.equal(report.quality_analysis.source_profile, "baseline");
  assert.equal(report.quality_analysis.independent_case_count, 3);
  assert.equal(report.quality_analysis.observation_count, 3);
  assert.equal(report.quality_analysis.audio_metrics_observation_count, 3);
  assert.equal(report.quality_analysis.confidence_observation_count, 3);
  const noiseSlice = report.quality_analysis.tag_slices.noise;
  assert.ok(noiseSlice);
  assert.equal(noiseSlice.case_count, 1);
  assert.equal(noiseSlice.cer, 0);
  assert.equal(
    report.quality_analysis.correlations.original_confidence_mean_vs_cer.status,
    "evaluated",
  );
  assert.notEqual(
    report.quality_analysis.correlations.original_confidence_mean_vs_cer.coefficient,
    null,
  );
  assert.equal(report.preprocessing.decision, "not_adopted");
  assert.equal(report.preprocessing.evidence_status, "noise_not_primary_in_dataset");
  assert.equal(report.preprocessing.noise_tagged_case_count, 1);
  assert.equal(report.preprocessing.noise_tagged_cer, 0);
  assert.ok(
    report.preprocessing.non_noise_cer !== null &&
    report.preprocessing.non_noise_cer > report.preprocessing.noise_tagged_cer,
  );
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
  const invalidConfidence = structuredClone(invalid) as unknown as {
    version: number;
    results: Record<string, unknown>[];
  };
  const invalidConfidenceResult = invalidConfidence.results[0];
  assert.ok(invalidConfidenceResult);
  delete invalidConfidenceResult.raw_audio;
  invalidConfidenceResult.case_id = "ja-clean-term";
  invalidConfidenceResult.audio_metrics = {
    rms_dbfs: -20,
    peak_dbfs: -1,
    clipped_sample_ratio: 0,
    near_silence_ratio: 0.1,
    original_token_count: 1,
    original_confidence_mean: null,
    original_confidence_min: null,
  };
  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify(invalidConfidence)),
    /confidence.*original_token_count/u,
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

void test("同一caseの複数試行を区別し、profileごとにまとめて集計する", () => {
  const sourceManifest = JSON.parse(manifestJson) as { cases: unknown[] };
  const manifest = parseSttEvaluationManifest(JSON.stringify({
    ...sourceManifest,
    cases: sourceManifest.cases.slice(0, 1),
  }));
  const result = (
    trial: number,
    profile: "baseline" | "context",
    transcript: string,
  ) => ({
    trial,
    case_id: "ja-clean-term",
    profile,
    transcript,
    segments: [transcript],
    recognized_languages: ["ja"],
    finalizations: [
      { kind: "finalized", reason: "speaking_end", latency_ms: 100 + trial, has_text: true },
    ],
    cpu_percent: trial,
    decoded_packet_count: 10,
    dropped_packet_count: 0,
    configuration: sttEvaluationProfileConfigurations[profile],
  });
  const observations = parseSttEvaluationObservations(JSON.stringify({
    version: 1,
    results: [
      result(1, "baseline", "今日は犬"),
      result(1, "context", "今日は猫"),
      result(2, "context", "今日は猫"),
      result(2, "baseline", "今日は猫"),
    ],
  }));

  const report = createSttEvaluationReport(manifest, observations);

  assert.equal(report.profiles.baseline?.case_count, 1);
  assert.equal(report.profiles.baseline.trial_count, 2);
  assert.equal(report.profiles.baseline.observation_count, 2);
  assert.deepEqual(report.profiles.baseline.cases.map((entry) => entry.trial), [1, 2]);
  assert.equal(report.profiles.baseline.cer, 1 / 8);
  assert.equal(report.profiles.context?.cer, 0);
  assert.equal(report.comparisons.context?.cer_relative_improvement_percent, 100);
  assert.throws(
    () => createSttEvaluationReport(manifest, {
      ...observations,
      results: observations.results.filter((entry) => !(
        entry.profile === "context" && entry.trial === 2
      )),
    }),
    /baselineと候補profileのtrial数/u,
  );
});

void test("追跡する人工音声レポートは本文・正解文・API keyを含まない", () => {
  const report = readFileSync("docs/evaluation/stt-artificial-2026-08-25.json", "utf8");
  const parsed = JSON.parse(report) as {
    profiles: Record<string, { trial_count: number; observation_count: number }>;
  };

  assert.doesNotMatch(
    report,
    /"(?:transcript|reference|translation_terms|api_key|raw_audio)"/u,
  );
  assert.match(report, /"manifest_sha256": "[a-f0-9]{64}"/u);
  assert.ok(Object.values(parsed.profiles).every((profile) => (
    profile.trial_count === 3 && profile.observation_count === 30
  )));
});

void test("追跡するendpoint比較は本文を含めず、不採用gateとtimeoutを保持する", () => {
  const timingReport = readFileSync(
    "docs/evaluation/stt-endpoint-timing-2026-08-26.json",
    "utf8",
  );
  const contextReport = readFileSync(
    "docs/evaluation/stt-context-endpoint-400-2026-08-26.json",
    "utf8",
  );
  const endpointOnlyFailure = readFileSync(
    "docs/evaluation/stt-endpoint-only-failure-2026-08-26.json",
    "utf8",
  );
  const forbidden = /"(?:transcript|reference|translation_terms|api_key|raw_audio|guild_id|user_id|trace_id|session_id)"/u;
  assert.doesNotMatch(timingReport, forbidden);
  assert.doesNotMatch(contextReport, forbidden);
  assert.doesNotMatch(endpointOnlyFailure, forbidden);

  const timing = JSON.parse(timingReport) as {
    dataset: { manifest_sha256: string };
    profiles: Record<string, { trial_count: number; observation_count: number }>;
    comparisons: Record<string, { gates: Record<string, string> }>;
  };
  assert.deepEqual(Object.keys(timing.profiles), [
    "baseline",
    "endpoint_fallback_400",
    "endpoint_fallback_600",
    "endpoint_fallback_800",
  ]);
  assert.ok(Object.values(timing.profiles).every((profile) => (
    profile.trial_count === 3 && profile.observation_count === 30
  )));
  const endpoint400 = timing.comparisons.endpoint_fallback_400;
  const endpoint600 = timing.comparisons.endpoint_fallback_600;
  const endpoint800 = timing.comparisons.endpoint_fallback_800;
  assert.ok(endpoint400);
  assert.ok(endpoint600);
  assert.ok(endpoint800);
  assert.equal(endpoint400.gates.key_terms, "fail");
  assert.equal(endpoint600.gates.latency, "fail");
  assert.equal(endpoint800.gates.latency, "fail");

  const context = JSON.parse(contextReport) as {
    comparisons: Record<string, { gates: Record<string, string> }>;
  };
  const contextEndpoint400 = context.comparisons.context_endpoint_fallback_400;
  assert.ok(contextEndpoint400);
  assert.equal(contextEndpoint400.gates.key_terms, "fail");
  assert.equal(contextEndpoint400.gates.semantic_endpoint, "fail");

  const failure = JSON.parse(endpointOnlyFailure) as {
    profile: string;
    configuration: unknown;
    dataset: {
      manifest_sha256: string;
      case: {
        packet_count: number;
        dropped_packet_count: number;
        duration_ms: number;
      };
    };
    trials: {
      trial: number;
      boundary_timeout_ms: number;
      outcome: string;
      cpu_percent: number;
    }[];
    outcome: string;
    full_dataset_scoring_completed: boolean;
    observations_written: boolean;
  };
  assert.equal(failure.profile, "endpoint_only_1000");
  assert.deepEqual(
    failure.configuration,
    sttEvaluationProfileConfigurations.endpoint_only_1000,
  );
  assert.equal(failure.dataset.manifest_sha256, timing.dataset.manifest_sha256);
  assert.equal(failure.dataset.case.packet_count, 348);
  assert.equal(failure.dataset.case.dropped_packet_count, 0);
  assert.ok(failure.dataset.case.duration_ms > 0);
  assert.deepEqual(failure.trials.map((trial) => trial.trial), [1, 2, 3]);
  assert.ok(failure.trials.every((trial) => (
    trial.boundary_timeout_ms === 10_000 &&
    trial.outcome === "boundary_timeout" &&
    trial.cpu_percent >= 0
  )));
  assert.equal(failure.outcome, "repeated_boundary_timeout");
  assert.equal(failure.full_dataset_scoring_completed, false);
  assert.equal(failure.observations_written, false);
});

void test("追跡するendpoint latency level比較は単一変数の実測結果と不採用根拠を保持する", () => {
  const reportText = readFileSync(
    "docs/evaluation/stt-endpoint-latency-level-2026-08-26.json",
    "utf8",
  );
  const forbidden = /"(?:transcript|reference|translation_terms|api_key|raw_audio|guild_id|user_id|trace_id|session_id)"/u;
  assert.doesNotMatch(reportText, forbidden);

  const report = JSON.parse(reportText) as {
    experiment: string;
    dataset: { manifest_sha256: string; cases: unknown[] };
    profile_mapping: Record<string, string>;
    profiles: Record<string, {
      trial_count: number;
      observation_count: number;
      unnatural_split_count: number;
      configuration: {
        manual_finalize_fallback_ms: number | null;
        soniox_endpoint_latency_adjustment_level: number | null;
      };
    }>;
    comparisons: Record<string, { gates: Record<string, string> }>;
  };
  assert.equal(report.experiment, "endpoint_latency_level");
  assert.match(report.dataset.manifest_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.dataset.cases.length, 10);
  assert.deepEqual(report.profile_mapping, {
    A: "baseline",
    B: "endpoint_fallback_400",
    C: "endpoint_fallback_400_level1",
  });
  assert.deepEqual(Object.keys(report.profiles), [
    "baseline",
    "endpoint_fallback_400",
    "endpoint_fallback_400_level1",
  ]);
  assert.ok(Object.values(report.profiles).every((profile) => (
    profile.trial_count === 3 && profile.observation_count === 30
  )));

  const baseline = report.profiles.baseline;
  const level0 = report.profiles.endpoint_fallback_400;
  const level1 = report.profiles.endpoint_fallback_400_level1;
  assert.ok(baseline);
  assert.ok(level0);
  assert.ok(level1);
  assert.equal(level0.configuration.manual_finalize_fallback_ms, 300);
  assert.equal(level1.configuration.manual_finalize_fallback_ms, 300);
  assert.equal(level0.configuration.soniox_endpoint_latency_adjustment_level, 0);
  assert.equal(level1.configuration.soniox_endpoint_latency_adjustment_level, 1);
  assert.ok(level1.unnatural_split_count > level0.unnatural_split_count);
  assert.ok(level0.unnatural_split_count > baseline.unnatural_split_count);

  const comparison = report.comparisons.endpoint_fallback_400_level1;
  assert.ok(comparison);
  assert.equal(comparison.gates.overall_cer, "pass");
  assert.equal(comparison.gates.latency, "pass");
  assert.equal(comparison.gates.semantic_endpoint, "pass");
  assert.equal(comparison.gates.key_terms, "fail");
  assert.equal(comparison.gates.pi_runtime, "not_evaluated");
});

void test("追跡する音質相関レポートは本文なしで前処理の不採用根拠を保持する", () => {
  const reportText = readFileSync(
    "docs/evaluation/stt-audio-quality-correlation-2026-08-26.json",
    "utf8",
  );
  const forbidden = /"(?:transcript|reference|translation_terms|api_key|raw_audio|guild_id|user_id|trace_id|session_id)"/u;
  assert.doesNotMatch(reportText, forbidden);

  const report = JSON.parse(reportText) as {
    profiles: { baseline: { trial_count: number; observation_count: number } };
    quality_analysis: {
      status: string;
      independent_case_count: number;
      audio_metrics_observation_count: number;
      confidence_observation_count: number;
      correlations: Record<string, { status: string; coefficient: number | null; case_count: number }>;
      tag_slices: Record<string, {
        case_count: number;
        cer: number;
        comparison_case_count: number;
        comparison_cer: number | null;
      }>;
      limitations: string[];
    };
    preprocessing: {
      decision: string;
      evidence_status: string;
      noise_tagged_case_count: number;
      noise_tagged_cer: number | null;
      non_noise_case_count: number;
      non_noise_cer: number | null;
    };
  };
  assert.equal(report.profiles.baseline.trial_count, 3);
  assert.equal(report.profiles.baseline.observation_count, 30);
  assert.equal(report.quality_analysis.status, "evaluated");
  assert.equal(report.quality_analysis.independent_case_count, 10);
  assert.equal(report.quality_analysis.audio_metrics_observation_count, 30);
  assert.equal(report.quality_analysis.confidence_observation_count, 24);
  assert.equal(
    report.quality_analysis.correlations.dropped_packet_ratio_vs_cer?.status,
    "insufficient_variation",
  );
  assert.equal(
    report.quality_analysis.correlations.original_confidence_min_vs_cer?.case_count,
    8,
  );
  assert.ok(report.quality_analysis.limitations.some((entry) => entry.includes("confidence")));
  const noise = report.quality_analysis.tag_slices.noise;
  assert.ok(noise);
  assert.equal(noise.case_count, 2);
  assert.equal(noise.comparison_case_count, 8);
  assert.ok(noise.comparison_cer !== null && noise.cer < noise.comparison_cer);
  assert.equal(report.preprocessing.decision, "not_adopted");
  assert.equal(report.preprocessing.evidence_status, "noise_not_primary_in_dataset");
  assert.equal(report.preprocessing.noise_tagged_case_count, 2);
  assert.equal(report.preprocessing.non_noise_case_count, 8);
  assert.ok(
    report.preprocessing.noise_tagged_cer !== null &&
    report.preprocessing.non_noise_cer !== null &&
    report.preprocessing.noise_tagged_cer < report.preprocessing.non_noise_cer,
  );
});

void test("追跡する認識用terms比較は両言語版とsource限定版の不採用gateを保持する", () => {
  const reportPaths = [
    "docs/evaluation/stt-recognition-terms-2026-08-26.json",
    "docs/evaluation/stt-recognition-source-terms-2026-08-26.json",
  ] as const;
  const reportTexts = reportPaths.map((reportPath) => readFileSync(reportPath, "utf8"));
  const forbidden = /"(?:transcript|reference|translation_terms|api_key|raw_audio|guild_id|user_id|trace_id|session_id)"/u;
  for (const reportText of reportTexts) assert.doesNotMatch(reportText, forbidden);

  const reports = reportTexts.map((reportText) => JSON.parse(reportText) as {
    dataset: { manifest_sha256: string };
    profiles: Record<string, {
      trial_count: number;
      observation_count: number;
      key_term_recall: number | null;
      language_switch_recall: number | null;
    }>;
    comparisons: Record<string, {
      cer_relative_improvement_percent: number | null;
      key_term_recall_change: number | null;
      language_switch_recall_change: number | null;
      gates: {
        overall_cer: string;
        key_terms: string;
        language_switching: string;
      };
    }>;
  });
  const [bilingual, sourceOnly] = reports;
  assert.ok(bilingual);
  assert.ok(sourceOnly);
  assert.equal(bilingual.dataset.manifest_sha256, sourceOnly.dataset.manifest_sha256);
  for (const report of reports) {
    for (const profile of Object.values(report.profiles)) {
      assert.equal(profile.trial_count, 3);
      assert.equal(profile.observation_count, 30);
    }
  }

  const bilingualComparison = bilingual.comparisons.recognition_terms;
  assert.ok(bilingualComparison);
  assert.ok(
    bilingualComparison.cer_relative_improvement_percent !== null &&
    bilingualComparison.cer_relative_improvement_percent > 10,
  );
  assert.equal(bilingualComparison.gates.key_terms, "fail");
  assert.equal(bilingualComparison.gates.language_switching, "fail");
  const sourceOnlyComparison = sourceOnly.comparisons.recognition_source_terms;
  assert.ok(sourceOnlyComparison);
  assert.ok(
    sourceOnlyComparison.cer_relative_improvement_percent !== null &&
    sourceOnlyComparison.cer_relative_improvement_percent < 0,
  );
  assert.equal(sourceOnlyComparison.gates.overall_cer, "fail");
  assert.equal(sourceOnlyComparison.gates.key_terms, "fail");
  assert.equal(sourceOnlyComparison.gates.language_switching, "fail");
});

void test("追跡するPi runtime snapshotは識別子を含めず候補gateを未評価とする", () => {
  const snapshot = readFileSync(
    "docs/evaluation/pi-runtime-baseline-2026-08-25.json",
    "utf8",
  );
  const parsed = JSON.parse(snapshot) as {
    scope: { issue_9_candidate_deployed: boolean };
    window: {
      requested: string;
      first_runtime_sample_at: string;
      last_runtime_sample_at: string;
      observed_runtime_span_hours: number;
    };
    decision: { candidate_pi_runtime_gate: string; audio_stall_gate: string };
  };

  assert.doesNotMatch(snapshot, /"(?:guild_id|user_id|trace_id|session_id|api_key)"/u);
  assert.equal(parsed.scope.issue_9_candidate_deployed, false);
  assert.equal(parsed.window.requested, "72h");
  const observedSpanHours = (
    Date.parse(parsed.window.last_runtime_sample_at)
    - Date.parse(parsed.window.first_runtime_sample_at)
  ) / 3_600_000;
  assert.equal(
    parsed.window.observed_runtime_span_hours,
    Number(observedSpanHours.toFixed(2)),
  );
  assert.ok(parsed.window.observed_runtime_span_hours < 72);
  assert.equal(parsed.decision.candidate_pi_runtime_gate, "not_evaluated");
  assert.equal(parsed.decision.audio_stall_gate, "not_evaluated");
});
