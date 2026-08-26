import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createSttInsertionTriageRunOrder,
  createSttInsertionTriageReport,
  parseSttInsertionTriageObservations,
  sttInsertionTriageConditionConfigurations,
  type SttInsertionTriageObservations,
} from "../src/evaluation/stt-insertion-triage.js";
import { sha256 } from "../src/evaluation/stt-insertion-audio.js";
import {
  scoreSttCharacterError,
  type SttEvaluationManifest,
} from "../src/evaluation/stt-evaluation.js";

const manifest: SttEvaluationManifest = {
  version: 1,
  pair: "ja-ko",
  audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
  cases: [{
    id: "problem-case",
    audio: "problem.pcm",
    packet_trace: "problem.packets.json",
    reference: "正解文",
    language: "ja",
    tags: ["clean"],
    key_terms: [],
    expected_languages: ["ja"],
    expected_segments: 1,
    translation_terms: [{ source: "正解", target: "정답" }],
  }],
};

function inputAudit(inputRoute: "pcm_direct" | "discord_opus_roundtrip") {
  return {
    source_audio_sha256: "a".repeat(64),
    source_sample_count: 960,
    source_duration_ms: 20,
    source_packet_count: 1,
    source_packet_send_count: 1,
    duplicate_source_packet_index_count: 0,
    missing_source_packet_count: 0,
    sent_speech_audio_sha256: inputRoute === "pcm_direct"
      ? "a".repeat(64)
      : "d".repeat(64),
    sent_speech_sample_count: 960,
    sent_speech_duration_ms: 20,
    opus_packet_count: inputRoute === "discord_opus_roundtrip" ? 1 : null,
    decoded_sample_count: 960,
    codec_padding_sample_count: 0,
    send_audio_call_count: 2,
    sent_audio_bytes: 21_120,
    sent_audio_duration_ms: 220,
    trailing_silence_ms: 200,
    finalize_call_count: 1,
    endpoint_event_count: 0,
    finalized_event_count: 1,
  } as const;
}

function observations(): SttInsertionTriageObservations {
  const conditions = Object.keys(sttInsertionTriageConditionConfigurations) as (
    keyof typeof sttInsertionTriageConditionConfigurations
  )[];
  return {
    version: 2,
    experiment: "insertion_triage",
    selected_case_ids: ["problem-case"],
    dataset: {
      manifest_sha256: "b".repeat(64),
      cases: [{
        case_id: "problem-case",
        audio_sha256: "a".repeat(64),
        packet_trace_sha256: "c".repeat(64),
        audio_bytes: 1_920,
        packet_count: 1,
        dropped_packet_count: 0,
        duration_ms: 20,
      }],
    },
    audio_audit: {
      audit_sha256: "e".repeat(64),
      manifest_sha256: "b".repeat(64),
      cases: [{
        case_id: "problem-case",
        reference_status: "verified",
        intended_reference_sha256: sha256(Buffer.from("TTSへ入力した文", "utf8")),
        heard_reference_sha256: sha256(Buffer.from("正解文", "utf8")),
        source_audio_sha256: "a".repeat(64),
        source_wav_sha256: "f".repeat(64),
        opus_roundtrip_audio_sha256: "d".repeat(64),
        opus_roundtrip_wav_sha256: "9".repeat(64),
      }],
    },
    results: conditions.map((condition, index) => {
      const configuration = sttInsertionTriageConditionConfigurations[condition];
      const transcript = index < 3 ? "正解文" : "正解文正解文";
      const characterError = scoreSttCharacterError("正解文", transcript);
      return {
        execution_index: index + 1,
        trial: 1,
        case_id: "problem-case",
        condition,
        reference_text: "正解文",
        transcript,
        recognized_languages: ["ja" as const],
        original_final_tokens: [{
          start_ms: 0,
          end_ms: 20,
          text: transcript,
          language: "ja",
          confidence: 0.9,
          received_at_ms: 25,
        }],
        duplicate_final_original_token_count: 0,
        accepted_boundaries: [configuration.finalization_mode === "historical_baseline"
          ? { kind: "finalized" as const, reason: "speaking_end" as const, received_at_ms: 220 }
          : { kind: "finalized" as const, reason: "known_file_end" as const, received_at_ms: 220 }],
        character_error: characterError,
        transcript_characters_per_second: characterError.hypothesis_characters / 0.02,
        input_audit: inputAudit(configuration.input_route),
        configuration,
      };
    }),
  };
}

void test("大量挿入triage観測は入力監査とP/A/B/C/Dを厳格に検証する", () => {
  const value = observations();
  assert.deepEqual(
    parseSttInsertionTriageObservations(JSON.stringify(value)),
    value,
  );

  const invalid = JSON.parse(JSON.stringify(value)) as {
    results: { input_audit: { finalize_call_count: number } }[];
  };
  const first = invalid.results[0];
  assert.ok(first);
  first.input_audit.finalize_call_count = 2;
  assert.throws(
    () => parseSttInsertionTriageObservations(JSON.stringify(invalid)),
    /finalize_call_count/u,
  );
});

void test("3ケース5試行の5条件は75観測となり、条件の開始位置を均等に回す", () => {
  const caseIds = ["case-a", "case-b", "case-c"];
  const order = createSttInsertionTriageRunOrder(caseIds, 5);

  assert.equal(order.length, 75);
  for (const caseId of caseIds) {
    const firstConditions = order
      .filter((entry) => entry.case_id === caseId && entry.condition_position === 0)
      .map((entry) => entry.condition);
    assert.equal(new Set(firstConditions).size, 5);
  }
});

void test("公開triage reportは本文を含めず、条件別CERと入力完全性を出す", () => {
  const report = createSttInsertionTriageReport(manifest, observations());
  const serialized = JSON.stringify(report);

  assert.equal(report.version, 2);
  assert.equal(report.experiment, "insertion_triage");
  assert.equal(report.scope.independent_case_count, 1);
  assert.equal(report.scope.heard_reference_audit, "verified");
  assert.equal(report.scope.positive_control, "historical_baseline");
  assert.equal(report.scope.source_channel_analysis, "not_applicable_source_pcm_mono");
  assert.equal(report.classification.status, "not_evaluated");
  assert.equal(report.conditions.pcm_stt_only.micro_cer, 0);
  assert.equal(report.conditions.opus_stt_only.edit_counts.insertions, 3);
  assert.equal(
    report.conditions.opus_stt_only.input_integrity.all_source_packets_sent_once,
    true,
  );
  assert.equal(
    report.conditions.opus_stt_only.input_integrity.all_opus_packets_accounted_for,
    true,
  );
  assert.equal(
    report.conditions.opus_stt_only.input_integrity.all_send_audio_calls_accounted_for,
    true,
  );
  assert.equal(
    report.conditions.opus_stt_only.input_integrity.all_source_audio_hashes_match_dataset,
    true,
  );
  assert.equal(
    report.conditions.opus_stt_only.input_integrity.all_finalize_calls_accounted_for,
    true,
  );
  assert.equal(report.conditions.opus_stt_only.input_integrity.all_endpoint_events_match_mode, true);
  assert.equal(report.conditions.opus_stt_only.cases[0]?.characters_per_second_mean, 300);
  assert.doesNotMatch(
    serialized,
    /正解文|"transcript":|"original_final_tokens":/u,
  );
});

void test("受理した境界はprovider event数と一致しなければならない", () => {
  const invalid = observations();
  const first = invalid.results[0];
  assert.ok(first);
  first.accepted_boundaries = [{
    kind: "endpoint",
    reason: "soniox_endpoint",
    received_at_ms: 100,
  }];
  first.input_audit.endpoint_event_count = 0;

  assert.throws(
    () => parseSttInsertionTriageObservations(JSON.stringify(invalid)),
    /受理した境界数/u,
  );
});

void test("陽性対照Pは旧baselineのtimer確定理由を保持する", () => {
  for (const reason of ["transcript_inactivity", "max_turn_duration"] as const) {
    const value = JSON.parse(JSON.stringify(observations())) as {
      results: {
        accepted_boundaries: { kind: string; reason: string; received_at_ms: number }[];
      }[];
    };
    const positiveControl = value.results[0];
    assert.ok(positiveControl);
    positiveControl.accepted_boundaries = [{
      kind: "finalized",
      reason,
      received_at_ms: 220,
    }];

    assert.doesNotThrow(
      () => parseSttInsertionTriageObservations(JSON.stringify(value)),
    );
  }
});

void test("境界種別と確定理由の矛盾を拒否する", () => {
  const invalid = JSON.parse(JSON.stringify(observations())) as {
    results: {
      accepted_boundaries: { kind: string; reason: string; received_at_ms: number }[];
      input_audit: { endpoint_event_count: number };
    }[];
  };
  const positiveControl = invalid.results[0];
  assert.ok(positiveControl);
  positiveControl.accepted_boundaries = [{
    kind: "endpoint",
    reason: "known_file_end",
    received_at_ms: 220,
  }];
  positiveControl.input_audit.endpoint_event_count = 1;

  assert.throws(
    () => parseSttInsertionTriageObservations(JSON.stringify(invalid)),
    /境界種別.*確定理由/u,
  );
});

void test("既知終端条件はfinalized eventを1回だけ受理する", () => {
  const invalid = observations();
  const knownFileEnd = invalid.results.find(
    (result) => result.condition === "pcm_stt_only",
  );
  assert.ok(knownFileEnd);
  knownFileEnd.input_audit.finalized_event_count = 2;

  assert.throws(
    () => parseSttInsertionTriageObservations(JSON.stringify(invalid)),
    /known file end/u,
  );
});

void test("private observationのverified referenceをCERの正解として使う", () => {
  const heardObservations = observations();
  for (const result of heardObservations.results) {
    result.transcript = result.reference_text;
    const firstToken = result.original_final_tokens[0];
    assert.ok(firstToken);
    firstToken.text = result.reference_text;
    result.character_error = scoreSttCharacterError(result.reference_text, result.transcript);
    result.transcript_characters_per_second =
      result.character_error.hypothesis_characters / 0.02;
  }

  const report = createSttInsertionTriageReport(manifest, heardObservations);

  assert.equal(report.scope.heard_reference_audit, "verified");
  for (const condition of Object.values(report.conditions)) {
    assert.equal(condition.micro_cer, 0);
  }
});

void test("追跡する入力preflightは3ケースの二重送信なしを本文・秘密値なしで保持する", () => {
  const reportText = readFileSync(
    "docs/evaluation/stt-insertion-input-preflight-2026-08-26.json",
    "utf8",
  );
  const report = JSON.parse(reportText) as {
    environment: {
      receiver: string;
      live_soniox: boolean;
      discord: boolean;
      raspberry_pi: boolean;
    };
    conditions: Record<string, { translation_terms_enabled: boolean }>;
    dataset: { independent_case_count: number; observation_count: number };
    cases: {
      source_packet_count: number;
      pcm_direct: {
        source_packet_send_count: number;
        duplicate_source_packet_index_count: number;
        missing_source_packet_count: number;
        send_audio_call_count: number;
        sent_audio_bytes: number;
        receiver_binary_message_count: number;
        receiver_binary_bytes: number;
        finalize_call_count: number;
      };
      discord_opus_roundtrip: {
        source_packet_send_count: number;
        duplicate_source_packet_index_count: number;
        missing_source_packet_count: number;
        send_audio_call_count: number;
        sent_audio_bytes: number;
        receiver_binary_message_count: number;
        receiver_binary_bytes: number;
        finalize_call_count: number;
      };
    }[];
    input_integrity: {
      all_source_audio_hashes_match_dataset: boolean;
      all_source_packets_sent_once: boolean;
      all_opus_packets_accounted_for: boolean;
      all_send_audio_calls_accounted_for: boolean;
      all_receiver_binary_messages_match_send_calls: boolean;
      all_receiver_binary_bytes_match_sent_audio_bytes: boolean;
      maximum_codec_padding_ms: number;
    };
    source_channel_check: { status: string; channel_count: number };
    decision: string;
  };

  assert.deepEqual(report.environment, {
    receiver: "local_fake_websocket",
    live_soniox: false,
    discord: false,
    raspberry_pi: false,
  });
  assert.equal(report.dataset.independent_case_count, 3);
  assert.equal(report.dataset.observation_count, 12);
  assert.ok(Object.values(report.conditions).every(
    (condition) => !condition.translation_terms_enabled,
  ));
  for (const entry of report.cases) {
    assert.equal(entry.pcm_direct.source_packet_send_count, entry.source_packet_count);
    assert.equal(entry.pcm_direct.duplicate_source_packet_index_count, 0);
    assert.equal(entry.pcm_direct.missing_source_packet_count, 0);
    assert.equal(
      entry.pcm_direct.receiver_binary_message_count,
      entry.pcm_direct.send_audio_call_count,
    );
    assert.equal(entry.pcm_direct.receiver_binary_bytes, entry.pcm_direct.sent_audio_bytes);
    assert.equal(entry.pcm_direct.finalize_call_count, 1);
    assert.equal(entry.discord_opus_roundtrip.source_packet_send_count, entry.source_packet_count);
    assert.equal(entry.discord_opus_roundtrip.duplicate_source_packet_index_count, 0);
    assert.equal(entry.discord_opus_roundtrip.missing_source_packet_count, 0);
    assert.equal(
      entry.discord_opus_roundtrip.receiver_binary_message_count,
      entry.discord_opus_roundtrip.send_audio_call_count,
    );
    assert.equal(
      entry.discord_opus_roundtrip.receiver_binary_bytes,
      entry.discord_opus_roundtrip.sent_audio_bytes,
    );
    assert.equal(entry.discord_opus_roundtrip.finalize_call_count, 1);
  }
  assert.equal(report.input_integrity.all_source_audio_hashes_match_dataset, true);
  assert.equal(report.input_integrity.all_source_packets_sent_once, true);
  assert.equal(report.input_integrity.all_opus_packets_accounted_for, true);
  assert.equal(report.input_integrity.all_send_audio_calls_accounted_for, true);
  assert.equal(report.input_integrity.all_receiver_binary_messages_match_send_calls, true);
  assert.equal(report.input_integrity.all_receiver_binary_bytes_match_sent_audio_bytes, true);
  assert.equal(report.input_integrity.maximum_codec_padding_ms, 7.375);
  assert.equal(report.source_channel_check.status, "not_applicable_source_mono");
  assert.equal(report.source_channel_check.channel_count, 1);
  assert.equal(report.decision, "ready_for_live_triage");
  assert.doesNotMatch(
    reportText,
    /"transcript":|"original_final_tokens":|SONIOX_API_KEY|api_key|\/home\//u,
  );
});
