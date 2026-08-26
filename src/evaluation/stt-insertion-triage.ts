import { z } from "zod";

import { sha256 } from "./stt-insertion-audio.js";
import type { SttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import {
  scoreSttCharacterError,
  type EditCounts,
  type SttEvaluationManifest,
} from "./stt-evaluation.js";

const conditionSchema = z.enum([
  "historical_baseline",
  "pcm_stt_only",
  "pcm_translation",
  "opus_stt_only",
  "opus_translation",
]);

const configurationSchema = z.object({
  input_route: z.enum(["pcm_direct", "discord_opus_roundtrip"]),
  recognition_context_enabled: z.literal(false),
  translation_enabled: z.boolean(),
  translation_terms_enabled: z.boolean(),
  endpoint_detection_enabled: z.boolean(),
  finalization_mode: z.enum(["historical_baseline", "known_file_end"]),
  discord_speaking_end_delay_ms: z.union([z.literal(100), z.null()]),
  manual_finalize_fallback_ms: z.union([z.literal(100), z.null()]),
  trailing_silence_ms: z.literal(200),
  preprocessing: z.literal("none"),
}).strict();

export const sttInsertionTriageConditionConfigurations = {
  historical_baseline: {
    input_route: "pcm_direct",
    recognition_context_enabled: false,
    translation_enabled: true,
    translation_terms_enabled: true,
    endpoint_detection_enabled: true,
    finalization_mode: "historical_baseline",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  pcm_stt_only: {
    input_route: "pcm_direct",
    recognition_context_enabled: false,
    translation_enabled: false,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    discord_speaking_end_delay_ms: null,
    manual_finalize_fallback_ms: null,
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  pcm_translation: {
    input_route: "pcm_direct",
    recognition_context_enabled: false,
    translation_enabled: true,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    discord_speaking_end_delay_ms: null,
    manual_finalize_fallback_ms: null,
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  opus_stt_only: {
    input_route: "discord_opus_roundtrip",
    recognition_context_enabled: false,
    translation_enabled: false,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    discord_speaking_end_delay_ms: null,
    manual_finalize_fallback_ms: null,
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  opus_translation: {
    input_route: "discord_opus_roundtrip",
    recognition_context_enabled: false,
    translation_enabled: true,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    discord_speaking_end_delay_ms: null,
    manual_finalize_fallback_ms: null,
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
} as const satisfies Readonly<Record<
  z.infer<typeof conditionSchema>,
  z.infer<typeof configurationSchema>
>>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const originalFinalTokenSchema = z.object({
  start_ms: z.number().nonnegative().nullable(),
  end_ms: z.number().nonnegative().nullable(),
  text: z.string(),
  language: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  received_at_ms: z.number().nonnegative(),
}).strict().superRefine((value, context) => {
  if ((value.start_ms === null) !== (value.end_ms === null)) {
    context.addIssue({
      code: "custom",
      message: "original final tokenの開始・終了時刻は両方nullまたは両方numberにしてください",
    });
  }
  if (value.start_ms !== null && value.end_ms !== null && value.end_ms < value.start_ms) {
    context.addIssue({
      code: "custom",
      path: ["end_ms"],
      message: "original final tokenの終了時刻は開始時刻以降にしてください",
    });
  }
});

const acceptedBoundarySchema = z.object({
  kind: z.enum(["endpoint", "finalized"]),
  reason: z.enum([
    "speaking_end",
    "transcript_inactivity",
    "max_turn_duration",
    "soniox_endpoint",
    "soniox_finalized",
    "known_file_end",
  ]),
  received_at_ms: z.number().nonnegative(),
}).strict().superRefine((value, context) => {
  const providerReasonMatches = value.kind === "endpoint"
    ? value.reason !== "soniox_finalized" && value.reason !== "known_file_end"
    : value.reason !== "soniox_endpoint";
  if (!providerReasonMatches) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "境界種別と確定理由が一致しません",
    });
  }
});

const inputAuditSchema = z.object({
  source_audio_sha256: sha256Schema,
  source_sample_count: z.number().int().positive(),
  source_duration_ms: z.number().positive(),
  source_packet_count: z.number().int().positive(),
  source_packet_send_count: z.number().int().nonnegative(),
  duplicate_source_packet_index_count: z.number().int().nonnegative(),
  missing_source_packet_count: z.number().int().nonnegative(),
  sent_speech_audio_sha256: sha256Schema,
  sent_speech_sample_count: z.number().int().positive(),
  sent_speech_duration_ms: z.number().positive(),
  opus_packet_count: z.number().int().nonnegative().nullable(),
  decoded_sample_count: z.number().int().positive(),
  codec_padding_sample_count: z.number().int().nonnegative(),
  send_audio_call_count: z.number().int().positive(),
  sent_audio_bytes: z.number().int().positive(),
  sent_audio_duration_ms: z.number().positive(),
  trailing_silence_ms: z.number().int().nonnegative(),
  finalize_call_count: z.number().int().nonnegative(),
  endpoint_event_count: z.number().int().nonnegative(),
  finalized_event_count: z.number().int().nonnegative(),
}).strict();

const editCountsSchema = z.object({
  substitutions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();
const characterErrorSchema = z.object({
  cer: z.number().nonnegative(),
  character_edits: z.number().int().nonnegative(),
  reference_characters: z.number().int().positive(),
  hypothesis_characters: z.number().int().nonnegative(),
  edit_counts: editCountsSchema,
}).strict();

const datasetEvidenceSchema = z.object({
  manifest_sha256: sha256Schema,
  cases: z.array(z.object({
    case_id: z.string().min(1),
    audio_sha256: sha256Schema,
    packet_trace_sha256: sha256Schema,
    audio_bytes: z.number().int().positive(),
    packet_count: z.number().int().positive(),
    dropped_packet_count: z.number().int().nonnegative(),
    duration_ms: z.number().positive(),
  }).strict()).min(1),
}).strict();

const audioAuditEvidenceSchema = z.object({
  audit_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  cases: z.array(z.object({
    case_id: z.string().min(1),
    reference_status: z.literal("verified"),
    intended_reference_sha256: sha256Schema,
    heard_reference_sha256: sha256Schema,
    source_audio_sha256: sha256Schema,
    source_wav_sha256: sha256Schema,
    opus_roundtrip_audio_sha256: sha256Schema,
    opus_roundtrip_wav_sha256: sha256Schema,
  }).strict()).min(1),
}).strict();

const resultSchema = z.object({
  execution_index: z.number().int().positive(),
  trial: z.number().int().min(1).max(10),
  case_id: z.string().min(1),
  condition: conditionSchema,
  reference_text: z.string().refine((value) => value.trim().length > 0),
  transcript: z.string(),
  recognized_languages: z.array(z.enum(["ja", "ko"])),
  original_final_tokens: z.array(originalFinalTokenSchema),
  duplicate_final_original_token_count: z.number().int().nonnegative(),
  accepted_boundaries: z.array(acceptedBoundarySchema).min(1),
  character_error: characterErrorSchema,
  transcript_characters_per_second: z.number().nonnegative(),
  input_audit: inputAuditSchema,
  configuration: configurationSchema,
}).strict().superRefine((value, context) => {
  const expected = sttInsertionTriageConditionConfigurations[value.condition];
  if (JSON.stringify(value.configuration) !== JSON.stringify(expected)) {
    context.addIssue({
      code: "custom",
      path: ["configuration"],
      message: `condition「${value.condition}」の設定と一致しません`,
    });
  }
  const expectsOpus = value.configuration.input_route === "discord_opus_roundtrip";
  if (expectsOpus !== (value.input_audit.opus_packet_count !== null)) {
    context.addIssue({
      code: "custom",
      path: ["input_audit", "opus_packet_count"],
      message: "入力経路とOpus packet観測が一致しません",
    });
  }
  const expectedScore = scoreSttCharacterError(value.reference_text, value.transcript);
  if (JSON.stringify(value.character_error) !== JSON.stringify(expectedScore)) {
    context.addIssue({
      code: "custom",
      path: ["character_error"],
      message: "referenceとtranscriptから再計算したCER内訳と一致しません",
    });
  }
  if (value.original_final_tokens.map((token) => token.text).join("") !== value.transcript) {
    context.addIssue({
      code: "custom",
      path: ["transcript"],
      message: "確定原文token列から再構成した本文と一致しません",
    });
  }
  const tokenIdentities = new Set<string>();
  let duplicateFinalOriginalTokenCount = 0;
  for (const token of value.original_final_tokens) {
    if (token.start_ms === null || token.end_ms === null) continue;
    const identity = JSON.stringify([
      token.start_ms,
      token.end_ms,
      token.text,
      token.language,
    ]);
    if (tokenIdentities.has(identity)) duplicateFinalOriginalTokenCount += 1;
    tokenIdentities.add(identity);
  }
  if (duplicateFinalOriginalTokenCount !== value.duplicate_final_original_token_count) {
    context.addIssue({
      code: "custom",
      path: ["duplicate_final_original_token_count"],
      message: "確定原文token列から再計算した重複数と一致しません",
    });
  }
  const expectedCharactersPerSecond = expectedScore.hypothesis_characters /
    (value.input_audit.sent_speech_duration_ms / 1_000);
  if (
    Math.abs(value.transcript_characters_per_second - expectedCharactersPerSecond) > 0.000_001
  ) {
    context.addIssue({
      code: "custom",
      path: ["transcript_characters_per_second"],
      message: "認識文字数と送信音声時間から再計算した値と一致しません",
    });
  }
  const historical = value.configuration.finalization_mode === "historical_baseline";
  const terminalBoundary = value.accepted_boundaries.at(-1);
  if (!terminalBoundary) {
    context.addIssue({
      code: "custom",
      path: ["accepted_boundaries"],
      message: "終端までに受理したSTT境界が必要です",
    });
    return;
  }
  const acceptedEndpointCount = value.accepted_boundaries.filter(
    (boundary) => boundary.kind === "endpoint",
  ).length;
  const acceptedFinalizedCount = value.accepted_boundaries.length - acceptedEndpointCount;
  if (value.accepted_boundaries.some((boundary, index, boundaries) => (
    index > 0 && boundary.received_at_ms < (boundaries[index - 1]?.received_at_ms ?? 0)
  ))) {
    context.addIssue({
      code: "custom",
      path: ["accepted_boundaries"],
      message: "受理した境界は受信時刻順に並べてください",
    });
  }
  if (
    acceptedEndpointCount > value.input_audit.endpoint_event_count ||
    acceptedFinalizedCount > value.input_audit.finalized_event_count
  ) {
    context.addIssue({
      code: "custom",
      path: ["accepted_boundaries"],
      message: "受理した境界数がproviderから受信したevent数を超えています",
    });
  }
  if (!historical && (
    value.input_audit.finalize_call_count !== 1 ||
    value.input_audit.trailing_silence_ms !== 200 ||
    value.input_audit.endpoint_event_count !== 0 ||
    value.input_audit.finalized_event_count !== 1 ||
    value.duplicate_final_original_token_count !== 0 ||
    value.accepted_boundaries.length !== 1 ||
    terminalBoundary.kind !== "finalized" ||
    terminalBoundary.reason !== "known_file_end"
  )) {
    context.addIssue({
      code: "custom",
      path: ["accepted_boundaries"],
      message: "known file end条件の確定観測と一致しません",
    });
  }
  if (historical) {
    const manualFinalizeBoundaryCount = value.accepted_boundaries.filter((boundary) => (
      boundary.reason === "speaking_end" ||
      boundary.reason === "transcript_inactivity" ||
      boundary.reason === "max_turn_duration"
    )).length;
    if (
      value.accepted_boundaries.some((boundary) => boundary.reason === "known_file_end") ||
      manualFinalizeBoundaryCount !== value.input_audit.finalize_call_count ||
      value.input_audit.trailing_silence_ms !==
        value.input_audit.finalize_call_count * 200 ||
      (value.input_audit.finalize_call_count === 0 &&
        value.input_audit.endpoint_event_count === 0 &&
        value.input_audit.finalized_event_count === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["input_audit", "finalize_call_count"],
        message: "historical baselineのprovider境界または手動確定と一致しません",
      });
    }
  }
});

const observationsSchema = z.object({
  version: z.literal(2),
  experiment: z.literal("insertion_triage"),
  selected_case_ids: z.array(z.string().min(1)).min(1),
  dataset: datasetEvidenceSchema,
  audio_audit: audioAuditEvidenceSchema,
  results: z.array(resultSchema).min(1),
}).strict().superRefine((value, context) => {
  const selectedCaseIds = new Set(value.selected_case_ids);
  if (selectedCaseIds.size !== value.selected_case_ids.length) {
    context.addIssue({
      code: "custom",
      path: ["selected_case_ids"],
      message: "selected case IDは重複させないでください",
    });
  }
  if (value.audio_audit.manifest_sha256 !== value.dataset.manifest_sha256) {
    context.addIssue({
      code: "custom",
      path: ["audio_audit", "manifest_sha256"],
      message: "音声監査とdatasetのmanifest SHA-256が一致しません",
    });
  }
  const evidenceByCase = new Map(value.dataset.cases.map((entry) => [entry.case_id, entry]));
  if (evidenceByCase.size !== value.dataset.cases.length) {
    context.addIssue({
      code: "custom",
      path: ["dataset", "cases"],
      message: "datasetのcase IDは重複させないでください",
    });
  }
  const auditByCase = new Map(value.audio_audit.cases.map((entry) => [entry.case_id, entry]));
  if (
    auditByCase.size !== value.audio_audit.cases.length ||
    value.audio_audit.cases.length !== value.selected_case_ids.length ||
    value.selected_case_ids.some((caseId) => !auditByCase.has(caseId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["audio_audit", "cases"],
      message: "verified音声監査はselected caseと重複なしで一致させてください",
    });
  }
  const combinations = new Set<string>();
  let maximumTrial = 0;
  for (const [index, result] of value.results.entries()) {
    maximumTrial = Math.max(maximumTrial, result.trial);
    if (result.execution_index !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "execution_index"],
        message: "execution_indexは実行順に1から連番にしてください",
      });
    }
    if (!selectedCaseIds.has(result.case_id)) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "case_id"],
        message: "selected case IDに含まれていません",
      });
    }
    const evidence = evidenceByCase.get(result.case_id);
    const audit = auditByCase.get(result.case_id);
    if (!audit) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "case_id"],
        message: "verified音声監査がありません",
      });
    }
    if (audit && sha256(Buffer.from(result.reference_text, "utf8")) !== audit.heard_reference_sha256) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "reference_text"],
        message: "音声監査のheard reference SHA-256と一致しません",
      });
    }
    if (evidence?.audio_sha256 !== result.input_audit.source_audio_sha256) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "source_audio_sha256"],
        message: "datasetの音声SHA-256と一致しません",
      });
    }
    if (audit?.source_audio_sha256 !== result.input_audit.source_audio_sha256) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "source_audio_sha256"],
        message: "音声監査のsource音声SHA-256と一致しません",
      });
    }
    const expectedSentSpeechSha256 = result.configuration.input_route === "pcm_direct"
      ? audit?.source_audio_sha256
      : audit?.opus_roundtrip_audio_sha256;
    if (expectedSentSpeechSha256 !== result.input_audit.sent_speech_audio_sha256) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "sent_speech_audio_sha256"],
        message: "音声監査の送信音声SHA-256と一致しません",
      });
    }
    if (evidence) {
      const expectedSourceSamples = evidence.audio_bytes / 2;
      if (result.input_audit.source_sample_count !== expectedSourceSamples) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "input_audit", "source_sample_count"],
          message: "datasetのPCM sample数と一致しません",
        });
      }
      if (result.input_audit.source_packet_count !== evidence.packet_count) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "input_audit", "source_packet_count"],
          message: "datasetのpacket数と一致しません",
        });
      }
    }
    const expectedSourceDurationMs = result.input_audit.source_sample_count / 48_000 * 1_000;
    if (Math.abs(result.input_audit.source_duration_ms - expectedSourceDurationMs) > 0.000_001) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "source_duration_ms"],
        message: "source sample数から求めた時間と一致しません",
      });
    }
    if (
      result.input_audit.decoded_sample_count !==
        result.input_audit.source_sample_count + result.input_audit.codec_padding_sample_count ||
      result.input_audit.sent_speech_sample_count !== result.input_audit.decoded_sample_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "decoded_sample_count"],
        message: "source sample数、codec padding、送信speech sample数が一致しません",
      });
    }
    const expectedSpeechDurationMs = result.input_audit.sent_speech_sample_count /
      48_000 * 1_000;
    if (
      Math.abs(result.input_audit.sent_speech_duration_ms - expectedSpeechDurationMs) >
        0.000_001
    ) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "sent_speech_duration_ms"],
        message: "送信speech sample数から求めた時間と一致しません",
      });
    }
    const expectedSentAudioBytes = result.input_audit.sent_speech_sample_count * 2 +
      48_000 * 2 * result.input_audit.trailing_silence_ms / 1_000;
    if (result.input_audit.sent_audio_bytes !== expectedSentAudioBytes) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "sent_audio_bytes"],
        message: "送信speechと末尾無音のbyte合計に一致しません",
      });
    }
    const expectedSendAudioCallCount = result.input_audit.source_packet_send_count +
      result.input_audit.finalize_call_count;
    if (result.input_audit.send_audio_call_count !== expectedSendAudioCallCount) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "send_audio_call_count"],
        message: "source packetと末尾無音のsendAudio回数に一致しません",
      });
    }
    const key = `${String(result.trial)}\u0000${result.case_id}\u0000${result.condition}`;
    if (combinations.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["results", index],
        message: "trial・case・conditionの組み合わせが重複しています",
      });
    }
    combinations.add(key);
  }
  if (maximumTrial > 0) {
    const expectedOrder = createSttInsertionTriageRunOrder(value.selected_case_ids, maximumTrial);
    const actualOrder = value.results.map((result) => ({
      trial: result.trial,
      case_id: result.case_id,
      condition: result.condition,
    }));
    const expectedComparable = expectedOrder.map(({ trial, case_id, condition }) => ({
      trial,
      case_id,
      condition,
    }));
    if (JSON.stringify(actualOrder) !== JSON.stringify(expectedComparable)) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "P/A/B/C/Dのローテーション実行順と一致しません",
      });
    }
  }
});

export type SttInsertionTriageCondition = z.infer<typeof conditionSchema>;
export type SttInsertionTriageConfiguration = z.infer<typeof configurationSchema>;
export type SttInsertionTriageInputAudit = z.infer<typeof inputAuditSchema>;
export type SttInsertionTriageObservations = z.infer<typeof observationsSchema>;

export function createSttInsertionTriageRunOrder(
  caseIds: readonly string[],
  trials: number,
): {
  trial: number;
  case_id: string;
  condition: SttInsertionTriageCondition;
  condition_position: number;
}[] {
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) {
    throw new Error("大量挿入triageのcase IDは重複なしで1件以上指定してください");
  }
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) {
    throw new Error("大量挿入triageのtrial数は1〜10にしてください");
  }
  const conditions = conditionSchema.options;
  const order: {
    trial: number;
    case_id: string;
    condition: SttInsertionTriageCondition;
    condition_position: number;
  }[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const [caseIndex, caseId] of caseIds.entries()) {
      const startIndex = (trial - 1 + caseIndex) % conditions.length;
      for (let offset = 0; offset < conditions.length; offset += 1) {
        const condition = conditions[(startIndex + offset) % conditions.length];
        if (!condition) throw new Error("大量挿入triageの条件順を解決できませんでした");
        order.push({ trial, case_id: caseId, condition, condition_position: offset });
      }
    }
  }
  return order;
}

export function parseSttInsertionTriageObservations(
  json: string,
): SttInsertionTriageObservations {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error("STT大量挿入triage観測が有効なJSONではありません", { cause: error });
  }
  const parsed = observationsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`STT大量挿入triage観測が不正です: ${issues}`);
}

type ScoredObservation = {
  trial: number;
  case_id: string;
  condition: SttInsertionTriageCondition;
  cer: number;
  character_edits: number;
  reference_characters: number;
  hypothesis_characters: number;
  edit_counts: EditCounts;
  characters_per_second: number;
  dataset_audio_sha256: string;
  input_audit: SttInsertionTriageInputAudit;
  configuration: SttInsertionTriageConfiguration;
  accepted_boundaries: z.infer<typeof acceptedBoundarySchema>[];
  duplicate_final_original_token_count: number;
};

function sumEditCounts(scores: readonly ScoredObservation[]): EditCounts {
  return scores.reduce<EditCounts>((total, score) => ({
    substitutions: total.substitutions + score.edit_counts.substitutions,
    deletions: total.deletions + score.edit_counts.deletions,
    insertions: total.insertions + score.edit_counts.insertions,
    total: total.total + score.edit_counts.total,
  }), { substitutions: 0, deletions: 0, insertions: 0, total: 0 });
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("平均対象がありません");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inputIntegrity(scores: readonly ScoredObservation[]) {
  const durationToleranceMs = 0.000_001;
  return {
    all_source_audio_hashes_match_dataset: scores.every(
      (score) => score.input_audit.source_audio_sha256 === score.dataset_audio_sha256,
    ),
    all_source_packets_sent_once: scores.every((score) => (
      score.input_audit.source_packet_send_count === score.input_audit.source_packet_count &&
      score.input_audit.duplicate_source_packet_index_count === 0 &&
      score.input_audit.missing_source_packet_count === 0
    )),
    all_opus_packets_accounted_for: scores.every((score) => (
      score.input_audit.opus_packet_count === null
        ? score.input_audit.codec_padding_sample_count === 0
        : score.input_audit.opus_packet_count === score.input_audit.source_packet_send_count
    )),
    all_send_audio_calls_accounted_for: scores.every((score) => (
      score.input_audit.send_audio_call_count === score.input_audit.source_packet_send_count +
        score.input_audit.finalize_call_count
    )),
    all_decoded_samples_accounted_for: scores.every((score) => (
      score.input_audit.decoded_sample_count ===
        score.input_audit.source_sample_count + score.input_audit.codec_padding_sample_count &&
      score.input_audit.sent_speech_sample_count === score.input_audit.decoded_sample_count
    )),
    all_sent_audio_durations_accounted_for: scores.every((score) => {
      const expected = score.input_audit.sent_speech_duration_ms +
        score.input_audit.trailing_silence_ms;
      return Math.abs(score.input_audit.sent_audio_duration_ms - expected) <= durationToleranceMs;
    }),
    all_finalize_calls_accounted_for: scores.every(
      (score) => score.input_audit.trailing_silence_ms ===
        score.input_audit.finalize_call_count * 200,
    ),
    all_finalization_matches_mode: scores.every((score) => (
      score.configuration.finalization_mode === "historical_baseline"
        ? score.input_audit.trailing_silence_ms === score.input_audit.finalize_call_count * 200
        : (
          score.input_audit.finalize_call_count === 1 &&
          score.input_audit.finalized_event_count === 1 &&
          score.accepted_boundaries.length === 1 &&
          score.accepted_boundaries[0]?.kind === "finalized" &&
          score.accepted_boundaries[0].reason === "known_file_end"
        )
    )),
    all_endpoint_events_match_mode: scores.every((score) => (
      score.configuration.endpoint_detection_enabled ||
      score.input_audit.endpoint_event_count === 0
    )),
    all_terminal_boundaries_observed: scores.every((score) => (
      score.input_audit.endpoint_event_count + score.input_audit.finalized_event_count >= 1
    )),
    all_accepted_boundaries_match_events: scores.every((score) => {
      const endpointCount = score.accepted_boundaries.filter(
        (boundary) => boundary.kind === "endpoint",
      ).length;
      const finalizedCount = score.accepted_boundaries.length - endpointCount;
      return endpointCount <= score.input_audit.endpoint_event_count &&
        finalizedCount <= score.input_audit.finalized_event_count;
    }),
    duplicate_final_original_token_count: scores.reduce(
      (sum, score) => sum + score.duplicate_final_original_token_count,
      0,
    ),
  };
}

function conditionScore(scores: readonly ScoredObservation[]) {
  const editCounts = sumEditCounts(scores);
  const referenceCharacters = scores.reduce(
    (sum, score) => sum + score.reference_characters,
    0,
  );
  const hypothesisCharacters = scores.reduce(
    (sum, score) => sum + score.hypothesis_characters,
    0,
  );
  const caseIds = [...new Set(scores.map((score) => score.case_id))];
  return {
    observation_count: scores.length,
    micro_cer: editCounts.total / referenceCharacters,
    macro_cer: mean(scores.map((score) => score.cer)),
    edit_counts: editCounts,
    character_counts: {
      reference_characters: referenceCharacters,
      hypothesis_characters: hypothesisCharacters,
    },
    input_integrity: inputIntegrity(scores),
    cases: caseIds.map((caseId) => {
      const caseScores = scores.filter((score) => score.case_id === caseId);
      const caseEdits = sumEditCounts(caseScores);
      const caseReferenceCharacters = caseScores.reduce(
        (sum, score) => sum + score.reference_characters,
        0,
      );
      return {
        case_id: caseId,
        observation_count: caseScores.length,
        micro_cer: caseEdits.total / caseReferenceCharacters,
        edit_counts: caseEdits,
        normalized_transcript_characters_mean: mean(
          caseScores.map((score) => score.hypothesis_characters),
        ),
        characters_per_second_mean: mean(
          caseScores.map((score) => score.characters_per_second),
        ),
      };
    }),
  };
}

export function createSttInsertionTriageReport(
  manifest: SttEvaluationManifest,
  rawObservations: SttInsertionTriageObservations,
) {
  const observations = parseSttInsertionTriageObservations(JSON.stringify(rawObservations));
  const manifestCaseIds = new Set(manifest.cases.map((evaluationCase) => evaluationCase.id));
  const evidenceByCaseId = new Map(observations.dataset.cases.map((evidence) => [
    evidence.case_id,
    evidence,
  ]));
  const scores: ScoredObservation[] = observations.results.map((result) => {
    if (!manifestCaseIds.has(result.case_id)) {
      throw new Error(`triage case「${result.case_id}」がmanifestにありません`);
    }
    const evidence = evidenceByCaseId.get(result.case_id);
    if (!evidence) throw new Error(`triage case「${result.case_id}」のdataset証跡がありません`);
    return {
      trial: result.trial,
      case_id: result.case_id,
      condition: result.condition,
      ...result.character_error,
      characters_per_second: result.transcript_characters_per_second,
      dataset_audio_sha256: evidence.audio_sha256,
      input_audit: result.input_audit,
      configuration: result.configuration,
      accepted_boundaries: result.accepted_boundaries,
      duplicate_final_original_token_count: result.duplicate_final_original_token_count,
    };
  });
  const conditions = Object.fromEntries(conditionSchema.options.map((condition) => [
    condition,
    {
      configuration: sttInsertionTriageConditionConfigurations[condition],
      ...conditionScore(scores.filter((score) => score.condition === condition)),
    },
  ])) as Record<SttInsertionTriageCondition, ReturnType<typeof conditionScore> & {
    configuration: SttInsertionTriageConfiguration;
  }>;
  const selectedEvidence = observations.dataset.cases.filter((entry) =>
    observations.selected_case_ids.includes(entry.case_id)
  );
  return {
    version: 2 as const,
    generated_at: new Date().toISOString(),
    experiment: "insertion_triage" as const,
    decision: "no_production_change" as const,
    scope: {
      independent_case_count: observations.selected_case_ids.length,
      trial_count: Math.max(...observations.results.map((result) => result.trial)),
      observation_count: observations.results.length,
      heard_reference_audit: "verified" as const,
      positive_control: "historical_baseline" as const,
      source_channel_analysis: "not_applicable_source_pcm_mono" as const,
      real_discord_audio: "not_evaluated" as const,
      raspberry_pi_runtime: "not_evaluated" as const,
    },
    audio_audit: {
      audit_sha256: observations.audio_audit.audit_sha256,
      status: "verified" as const,
      case_count: observations.audio_audit.cases.length,
    },
    dataset: {
      manifest_sha256: observations.dataset.manifest_sha256,
      cases: selectedEvidence,
    } satisfies SttEvaluationDatasetEvidence,
    conditions,
    classification: {
      status: "not_evaluated" as const,
      categories: [
        "repetition",
        "cross-boundary",
        "language-duplication",
        "reference-mismatch",
        "silence-hallucination",
        "other",
      ] as const,
      reason: "heard referenceは採点に使用しましたが、人による認識文分類がないため、自動で原因を決めません",
    },
  };
}
