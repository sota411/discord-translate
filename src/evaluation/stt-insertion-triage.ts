import { z } from "zod";

import type { SttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import {
  scoreSttCharacterError,
  sttEvaluationScoringReference,
  type EditCounts,
  type SttEvaluationManifest,
} from "./stt-evaluation.js";

const conditionSchema = z.enum([
  "pcm_stt_only",
  "pcm_translation",
  "opus_stt_only",
  "opus_translation",
]);

const configurationSchema = z.object({
  input_route: z.enum(["pcm_direct", "discord_opus_roundtrip"]),
  translation_enabled: z.boolean(),
  translation_terms_enabled: z.literal(false),
  endpoint_detection_enabled: z.literal(false),
  finalization_mode: z.literal("known_file_end"),
  trailing_silence_ms: z.literal(200),
  preprocessing: z.literal("none"),
}).strict();

export const sttInsertionTriageConditionConfigurations = {
  pcm_stt_only: {
    input_route: "pcm_direct",
    translation_enabled: false,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  pcm_translation: {
    input_route: "pcm_direct",
    translation_enabled: true,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  opus_stt_only: {
    input_route: "discord_opus_roundtrip",
    translation_enabled: false,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
  opus_translation: {
    input_route: "discord_opus_roundtrip",
    translation_enabled: true,
    translation_terms_enabled: false,
    endpoint_detection_enabled: false,
    finalization_mode: "known_file_end",
    trailing_silence_ms: 200,
    preprocessing: "none",
  },
} as const satisfies Readonly<Record<
  z.infer<typeof conditionSchema>,
  z.infer<typeof configurationSchema>
>>;

const originalFinalTokenSchema = z.object({
  start_ms: z.number().nonnegative().nullable(),
  end_ms: z.number().nonnegative().nullable(),
  text: z.string(),
  language: z.string().nullable(),
  confidence: z.number().min(0).max(1),
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

const inputAuditSchema = z.object({
  source_audio_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_sample_count: z.number().int().positive(),
  source_duration_ms: z.number().positive(),
  source_packet_count: z.number().int().positive(),
  source_packet_send_count: z.number().int().nonnegative(),
  duplicate_source_packet_index_count: z.number().int().nonnegative(),
  missing_source_packet_count: z.number().int().nonnegative(),
  opus_packet_count: z.number().int().nonnegative().nullable(),
  decoded_sample_count: z.number().int().positive(),
  codec_padding_sample_count: z.number().int().nonnegative(),
  send_audio_call_count: z.number().int().positive(),
  sent_audio_bytes: z.number().int().positive(),
  sent_audio_duration_ms: z.number().positive(),
  injected_silence_ms: z.literal(200),
  finalize_call_count: z.literal(1),
  endpoint_event_count: z.number().int().nonnegative(),
  finalized_event_count: z.number().int().nonnegative(),
}).strict();

const datasetEvidenceSchema = z.object({
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  cases: z.array(z.object({
    case_id: z.string().min(1),
    audio_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    packet_trace_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    audio_bytes: z.number().int().positive(),
    packet_count: z.number().int().positive(),
    dropped_packet_count: z.number().int().nonnegative(),
    duration_ms: z.number().positive(),
  }).strict()).min(1),
}).strict();

const resultSchema = z.object({
  trial: z.number().int().min(1).max(10),
  case_id: z.string().min(1),
  condition: conditionSchema,
  transcript: z.string(),
  recognized_languages: z.array(z.enum(["ja", "ko"])),
  original_final_tokens: z.array(originalFinalTokenSchema),
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
});

const observationsSchema = z.object({
  version: z.literal(1),
  experiment: z.literal("insertion_triage"),
  selected_case_ids: z.array(z.string().min(1)).min(1),
  dataset: datasetEvidenceSchema,
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
  const evidenceByCase = new Map(value.dataset.cases.map((entry) => [entry.case_id, entry]));
  const combinations = new Set<string>();
  let maximumTrial = 0;
  for (const [index, result] of value.results.entries()) {
    maximumTrial = Math.max(maximumTrial, result.trial);
    if (!selectedCaseIds.has(result.case_id)) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "case_id"],
        message: "selected case IDに含まれていません",
      });
    }
    const evidence = evidenceByCase.get(result.case_id);
    if (evidence?.audio_sha256 !== result.input_audit.source_audio_sha256) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "source_audio_sha256"],
        message: "datasetの音声SHA-256と一致しません",
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
        result.input_audit.source_sample_count + result.input_audit.codec_padding_sample_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "decoded_sample_count"],
        message: "source sample数とcodec paddingの合計に一致しません",
      });
    }
    const expectedSentAudioBytes = result.input_audit.decoded_sample_count * 2 +
      48_000 * 2 * result.input_audit.injected_silence_ms / 1_000;
    if (result.input_audit.sent_audio_bytes !== expectedSentAudioBytes) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "input_audit", "sent_audio_bytes"],
        message: "decoded PCMと追加無音のbyte合計に一致しません",
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
  for (let trial = 1; trial <= maximumTrial; trial += 1) {
    for (const caseId of value.selected_case_ids) {
      for (const condition of conditionSchema.options) {
        const key = `${String(trial)}\u0000${caseId}\u0000${condition}`;
        if (!combinations.has(key)) {
          context.addIssue({
            code: "custom",
            path: ["results"],
            message: `trial「${String(trial)}」case「${caseId}」condition「${condition}」がありません`,
          });
        }
      }
    }
  }
});

export type SttInsertionTriageCondition = z.infer<typeof conditionSchema>;
export type SttInsertionTriageConfiguration = z.infer<typeof configurationSchema>;
export type SttInsertionTriageInputAudit = z.infer<typeof inputAuditSchema>;
export type SttInsertionTriageObservations = z.infer<typeof observationsSchema>;

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
      score.input_audit.send_audio_call_count ===
        score.input_audit.source_packet_send_count + 1
    )),
    all_decoded_samples_accounted_for: scores.every((score) => (
      score.input_audit.decoded_sample_count ===
        score.input_audit.source_sample_count + score.input_audit.codec_padding_sample_count
    )),
    all_sent_audio_durations_accounted_for: scores.every((score) => {
      const expected = score.input_audit.decoded_sample_count / 48_000 * 1_000 +
        score.input_audit.injected_silence_ms;
      return Math.abs(score.input_audit.sent_audio_duration_ms - expected) <= durationToleranceMs;
    }),
    all_finalize_once: true,
    all_endpoint_events_zero: scores.every(
      (score) => score.input_audit.endpoint_event_count === 0,
    ),
    all_finalized_once: scores.every(
      (score) => score.input_audit.finalized_event_count === 1,
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
  const casesById = new Map(manifest.cases.map((evaluationCase) => [
    evaluationCase.id,
    evaluationCase,
  ]));
  const evidenceByCaseId = new Map(observations.dataset.cases.map((evidence) => [
    evidence.case_id,
    evidence,
  ]));
  const scores: ScoredObservation[] = observations.results.map((result) => {
    const evaluationCase = casesById.get(result.case_id);
    if (!evaluationCase) throw new Error(`triage case「${result.case_id}」がmanifestにありません`);
    const evidence = evidenceByCaseId.get(result.case_id);
    if (!evidence) throw new Error(`triage case「${result.case_id}」のdataset証跡がありません`);
    const score = scoreSttCharacterError(
      sttEvaluationScoringReference(evaluationCase),
      result.transcript,
    );
    return {
      trial: result.trial,
      case_id: result.case_id,
      condition: result.condition,
      ...score,
      characters_per_second: score.hypothesis_characters /
        (result.input_audit.source_duration_ms / 1_000),
      dataset_audio_sha256: evidence.audio_sha256,
      input_audit: result.input_audit,
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
  const heardReferenceCount = observations.selected_case_ids.filter((caseId) =>
    casesById.get(caseId)?.heard_reference !== undefined
  ).length;
  let heardReferenceAudit: "evaluated" | "partially_evaluated" | "not_evaluated";
  if (heardReferenceCount === 0) {
    heardReferenceAudit = "not_evaluated";
  } else if (heardReferenceCount === observations.selected_case_ids.length) {
    heardReferenceAudit = "evaluated";
  } else {
    heardReferenceAudit = "partially_evaluated";
  }
  return {
    version: 1 as const,
    generated_at: new Date().toISOString(),
    experiment: "insertion_triage" as const,
    decision: "no_production_change" as const,
    scope: {
      independent_case_count: observations.selected_case_ids.length,
      trial_count: Math.max(...observations.results.map((result) => result.trial)),
      observation_count: observations.results.length,
      heard_reference_audit: heardReferenceAudit,
      source_channel_analysis: "not_applicable_source_pcm_mono" as const,
      real_discord_audio: "not_evaluated" as const,
      raspberry_pi_runtime: "not_evaluated" as const,
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
      reason: heardReferenceAudit === "evaluated"
        ? "heard referenceは採点に使用しましたが、人による認識文分類がないため、自動で原因を決めません"
        : "全caseのheard referenceと人による認識文分類がないため、自動で原因を決めません",
    },
  };
}
