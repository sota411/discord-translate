import { z } from "zod";

import { languagePairs } from "../domain/language-pair.js";

const evaluationLanguageSchema = z.enum(["ja", "ko"]);
const evaluationExperimentSchema = z.enum([
  "context_endpoint",
  "endpoint_timing",
  "context_endpoint_400",
  "endpoint_latency_level",
  "recognition_terms",
  "recognition_source_terms",
  "provider_comparison",
]);
const evaluationProfileSchema = z.enum([
  "baseline",
  "context",
  "endpoint",
  "context_endpoint",
  "endpoint_fallback_400",
  "endpoint_fallback_600",
  "endpoint_fallback_800",
  "endpoint_only_1000",
  "context_endpoint_fallback_400",
  "endpoint_fallback_400_level1",
  "recognition_terms",
  "recognition_source_terms",
  "amazon_transcribe",
]);
const sonioxSttEvaluationConfigurationSchema = z.object({
  recognition_context_enabled: z.boolean(),
  recognition_context_mode: z.enum(["terms_only", "source_terms_only"]).optional(),
  endpoint_mode: z.enum(["manual_early", "soniox_primary", "soniox_only"]),
  discord_speaking_end_delay_ms: z.number().int().nonnegative(),
  manual_finalize_fallback_ms: z.number().int().nonnegative().nullable(),
  soniox_max_endpoint_delay_ms: z.number().int().positive(),
  soniox_endpoint_latency_adjustment_level: z.number().int().min(0).max(3).nullable()
    .default(null),
  soniox_endpoint_sensitivity: z.number().min(-1).max(1).nullable().default(null),
  endpoint_silence_chunk_ms: z.number().int().positive().nullable().default(null),
  preprocessing: z.literal("none"),
}).strict();
const amazonTranscribeEvaluationConfigurationSchema = z.object({
  provider: z.literal("amazon_transcribe"),
  identify_multiple_languages: z.literal(true),
  language_options: z.tuple([z.literal("ja-JP"), z.literal("ko-KR")]).readonly(),
  media_encoding: z.literal("pcm"),
  media_sample_rate_hertz: z.literal(48_000),
  partial_results_stabilization: z.literal(false),
  preprocessing: z.literal("none"),
}).strict();
const sttEvaluationConfigurationSchema = z.union([
  sonioxSttEvaluationConfigurationSchema,
  amazonTranscribeEvaluationConfigurationSchema,
]);
export type SttEvaluationConfiguration = z.infer<typeof sttEvaluationConfigurationSchema>;

export const sttEvaluationProfileConfigurations = {
  baseline: {
    recognition_context_enabled: false,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  context: {
    recognition_context_enabled: true,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  endpoint: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  context_endpoint: {
    recognition_context_enabled: true,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  endpoint_fallback_400: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 300,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 0,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  endpoint_fallback_600: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 500,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 0,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  endpoint_fallback_800: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 700,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 0,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  endpoint_only_1000: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_only",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: null,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 0,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  context_endpoint_fallback_400: {
    recognition_context_enabled: true,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 300,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 0,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  endpoint_fallback_400_level1: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 300,
    soniox_max_endpoint_delay_ms: 1_000,
    soniox_endpoint_latency_adjustment_level: 1,
    soniox_endpoint_sensitivity: 0,
    endpoint_silence_chunk_ms: 20,
    preprocessing: "none",
  },
  recognition_terms: {
    recognition_context_enabled: true,
    recognition_context_mode: "terms_only",
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  recognition_source_terms: {
    recognition_context_enabled: true,
    recognition_context_mode: "source_terms_only",
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    soniox_endpoint_latency_adjustment_level: null,
    soniox_endpoint_sensitivity: null,
    endpoint_silence_chunk_ms: null,
    preprocessing: "none",
  },
  amazon_transcribe: {
    provider: "amazon_transcribe",
    identify_multiple_languages: true,
    language_options: ["ja-JP", "ko-KR"],
    media_encoding: "pcm",
    media_sample_rate_hertz: 48_000,
    partial_results_stabilization: false,
    preprocessing: "none",
  },
} as const satisfies Readonly<Record<
  z.infer<typeof evaluationProfileSchema>,
  SttEvaluationConfiguration
>>;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const translationTermSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
}).strict();
const evaluationCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u),
  audio: z.string().trim().min(1),
  reference: z.string().refine((value) => value.trim().length > 0),
  language: evaluationLanguageSchema,
  tags: z.array(z.string().trim().min(1)),
  key_terms: z.array(z.string().trim().min(1)),
  expected_languages: z.array(evaluationLanguageSchema).min(1),
  expected_segments: z.number().int().positive(),
  packet_trace: z.string().trim().min(1),
  translation_terms: z.array(translationTermSchema),
}).strict().superRefine((value, context) => {
  const uniqueFields = [
    ["tags", value.tags],
    ["key_terms", value.key_terms],
    ["expected_languages", value.expected_languages],
  ] as const;
  for (const [name, entries] of uniqueFields) {
    if (new Set(entries).size !== entries.length) {
      context.addIssue({
        code: "custom",
        path: [name],
        message: `${name}を重複させないでください`,
      });
    }
  }
});
const evaluationManifestSchema = z.object({
  version: z.literal(1),
  pair: z.enum(languagePairs),
  audio: z.object({
    format: z.literal("pcm_s16le"),
    sample_rate: z.literal(48_000),
    channels: z.literal(1),
  }).strict(),
  cases: z.array(evaluationCaseSchema).min(1),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, evaluationCase] of value.cases.entries()) {
    if (ids.has(evaluationCase.id)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "id"],
        message: `case id「${evaluationCase.id}」が重複しています`,
      });
    }
    ids.add(evaluationCase.id);
  }
});

const nullableDbfsSchema = z.number().max(0).nullable();
const nullableRatioSchema = z.number().min(0).max(1).nullable();
const nullableConfidenceSchema = z.number().min(0).max(1).nullable();
const evaluationAudioMetricsSchema = z.object({
  rms_dbfs: nullableDbfsSchema,
  peak_dbfs: nullableDbfsSchema,
  clipped_sample_ratio: nullableRatioSchema,
  near_silence_ratio: nullableRatioSchema,
  original_token_count: z.number().int().nonnegative(),
  original_confidence_mean: nullableConfidenceSchema,
  original_confidence_min: nullableConfidenceSchema,
}).strict().superRefine((value, context) => {
  const hasMean = value.original_confidence_mean !== null;
  const hasMinimum = value.original_confidence_min !== null;
  if (
    (value.original_token_count === 0 && (hasMean || hasMinimum)) ||
    (value.original_token_count > 0 && (!hasMean || !hasMinimum))
  ) {
    context.addIssue({
      code: "custom",
      path: ["original_token_count"],
      message: "confidenceの有無とoriginal_token_countを一致させてください",
    });
  }
  if (
    value.original_confidence_mean !== null &&
    value.original_confidence_min !== null &&
    value.original_confidence_min > value.original_confidence_mean
  ) {
    context.addIssue({
      code: "custom",
      path: ["original_confidence_min"],
      message: "original_confidence_minはmean以下にしてください",
    });
  }
});

const evaluationResultSchema = z.object({
  trial: z.number().int().positive().default(1),
  case_id: z.string().min(1),
  profile: evaluationProfileSchema,
  transcript: z.string(),
  segments: z.array(z.string()),
  recognized_languages: z.array(evaluationLanguageSchema),
  finalizations: z.array(z.object({
    kind: z.enum(["endpoint", "finalized"]),
    reason: z.enum([
      "speaking_end",
      "transcript_inactivity",
      "max_turn_duration",
      "soniox_endpoint",
      "soniox_finalized",
      "provider_final",
    ]),
    latency_ms: z.number().nonnegative(),
    has_text: z.boolean(),
  }).strict()).min(1),
  cpu_percent: z.number().nonnegative(),
  decoded_packet_count: z.number().int().positive(),
  dropped_packet_count: z.number().int().nonnegative(),
  audio_metrics: evaluationAudioMetricsSchema.optional(),
  configuration: sttEvaluationConfigurationSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.recognized_languages).size !== value.recognized_languages.length) {
    context.addIssue({
      code: "custom",
      path: ["recognized_languages"],
      message: "recognized_languagesを重複させないでください",
    });
  }
  const expectedConfiguration = sttEvaluationProfileConfigurations[value.profile];
  if (JSON.stringify(value.configuration) !== JSON.stringify(expectedConfiguration)) {
    context.addIssue({
      code: "custom",
      path: ["configuration"],
      message: `profile「${value.profile}」の実効設定と一致しません`,
    });
  }
  if (value.profile === "amazon_transcribe") {
    const finalization = value.finalizations[0];
    if (
      value.finalizations.length !== 1 ||
      finalization?.kind !== "finalized" ||
      finalization.reason !== "provider_final"
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalizations"],
        message: "profile「amazon_transcribe」の確定理由はprovider_final 1件にしてください",
      });
    }
    if (finalization?.has_text !== (value.transcript.trim().length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["finalizations", 0, "has_text"],
        message: "profile「amazon_transcribe」のhas_textを確定本文の有無と一致させてください",
      });
    }
  } else if (value.finalizations.some((finalization) => (
    finalization.reason === "provider_final"
  ))) {
    context.addIssue({
      code: "custom",
      path: ["finalizations"],
      message: `profile「${value.profile}」にprovider_finalは指定できません`,
    });
  }
});
const evaluationDatasetEvidenceSchema = z.object({
  manifest_sha256: sha256Schema,
  cases: z.array(z.object({
    case_id: z.string().min(1),
    audio_sha256: sha256Schema,
    packet_trace_sha256: sha256Schema,
    audio_bytes: z.number().int().positive(),
    packet_count: z.number().int().positive(),
    dropped_packet_count: z.number().int().nonnegative(),
    duration_ms: z.number().nonnegative(),
  }).strict()).min(1),
}).strict();
const providerEnvironmentSchema = z.object({
  amazon_transcribe: z.object({
    region: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u),
  }).strict(),
}).strict();
const evaluationObservationsSchema = z.object({
  version: z.literal(1),
  experiment: evaluationExperimentSchema.default("context_endpoint"),
  provider_environment: providerEnvironmentSchema.optional(),
  dataset: evaluationDatasetEvidenceSchema.optional(),
  results: z.array(evaluationResultSchema).min(1),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  const allowedProfiles = new Set(
    Object.values(sttEvaluationExperimentProfileMappings[value.experiment]),
  );
  for (const [index, result] of value.results.entries()) {
    if (!allowedProfiles.has(result.profile)) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "profile"],
        message: `experiment「${value.experiment}」にprofile「${result.profile}」は含まれません`,
      });
    }
    const key = `${String(result.trial)}\u0000${result.profile}\u0000${result.case_id}`;
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["results", index],
        message: `trial、profile、case_idの組「${String(result.trial)}/${result.profile}/${result.case_id}」が重複しています`,
      });
    }
    keys.add(key);
  }
  if (value.experiment === "provider_comparison" && !value.provider_environment) {
    context.addIssue({
      code: "custom",
      path: ["provider_environment"],
      message: "provider_comparisonには実測リージョンが必要です",
    });
  }
  if (value.experiment !== "provider_comparison" && value.provider_environment) {
    context.addIssue({
      code: "custom",
      path: ["provider_environment"],
      message: "provider_environmentはprovider_comparisonだけに指定してください",
    });
  }
});

export type SttEvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type SttEvaluationObservations = z.infer<typeof evaluationObservationsSchema>;
export type SttEvaluationExperiment = z.infer<typeof evaluationExperimentSchema>;
export type SttEvaluationProfile = z.infer<typeof evaluationProfileSchema>;
type SttEvaluationCase = SttEvaluationManifest["cases"][number];
type SttEvaluationResult = SttEvaluationObservations["results"][number];
type SttEvaluationAudioMetrics = z.infer<typeof evaluationAudioMetricsSchema>;

export const sttEvaluationExperimentProfileMappings = {
  context_endpoint: {
    A: "baseline",
    B: "context",
    C: "endpoint",
    D: "context_endpoint",
  },
  endpoint_timing: {
    A: "baseline",
    B: "endpoint_fallback_400",
    C: "endpoint_fallback_600",
    D: "endpoint_fallback_800",
    E: "endpoint_only_1000",
  },
  context_endpoint_400: {
    A: "baseline",
    B: "endpoint_fallback_400",
    C: "context_endpoint_fallback_400",
  },
  endpoint_latency_level: {
    A: "baseline",
    B: "endpoint_fallback_400",
    C: "endpoint_fallback_400_level1",
  },
  recognition_terms: {
    A: "baseline",
    B: "recognition_terms",
  },
  recognition_source_terms: {
    A: "baseline",
    B: "recognition_source_terms",
  },
  provider_comparison: {
    A: "baseline",
    B: "amazon_transcribe",
  },
} as const satisfies Readonly<Record<
  SttEvaluationExperiment,
  Readonly<Record<string, SttEvaluationProfile>>
>>;

export const sttEvaluationProfileMapping =
  sttEvaluationExperimentProfileMappings.context_endpoint;

export function parseSttEvaluationExperiment(value: string): SttEvaluationExperiment {
  const parsed = evaluationExperimentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `STT評価experimentは${evaluationExperimentSchema.options.join("、")}のいずれかにしてください`,
  );
}

type GateResult = "pass" | "fail" | "not_evaluated";

type CaseScore = {
  trial: number;
  case_id: string;
  cer: number;
  character_edits: number;
  reference_characters: number;
  key_term_recall: number | null;
  key_terms_recalled: number;
  key_terms_expected: number;
  language_recall: number;
  languages_recalled: number;
  languages_expected: number;
  segment_count: number;
  expected_segments: number;
  unnatural_split_count: number;
  decoded_packet_count: number;
  dropped_packet_count: number;
  dropped_packet_ratio: number;
  audio_metrics: SttEvaluationAudioMetrics | null;
  finalizations: {
    kind: "endpoint" | "finalized";
    reason:
      | "speaking_end"
      | "transcript_inactivity"
      | "max_turn_duration"
      | "soniox_endpoint"
      | "soniox_finalized"
      | "provider_final";
    latency_ms: number;
    has_text: boolean;
  }[];
};

type ProfileScore = {
  case_count: number;
  trial_count: number;
  observation_count: number;
  preprocessing: "none";
  configuration: SttEvaluationConfiguration;
  cer: number;
  clean_cer: number | null;
  key_term_recall: number | null;
  language_recall: number;
  language_switch_recall: number | null;
  code_switch_cer: number | null;
  unnatural_split_count: number;
  latency_ms: { mean: number; p50: number; p95: number };
  finalization: {
    observed_boundary_count: number;
    adoption_boundary_count: number;
    observed_endpoint_count: number;
    observed_finalized_count: number;
    soniox_endpoint_count: number;
    manual_fallback_count: number;
    soniox_endpoint_ratio: number;
  };
  cpu_percent: { mean: number; p95: number };
  packets: {
    decoded_mean: number;
    dropped_mean: number;
    dropped_ratio: number;
  };
  cases: CaseScore[];
};

type ProfileComparison = {
  cer_relative_improvement_percent: number | null;
  key_term_recall_change: number | null;
  clean_cer_point_change: number | null;
  language_switch_recall_change: number | null;
  code_switch_cer_point_change: number | null;
  p95_added_latency_ms: number;
  baseline_transcript_coverage?: number;
  candidate_transcript_coverage?: number;
  transcript_coverage_change?: number;
  gates: {
    overall_cer: GateResult;
    key_terms: GateResult;
    clean_cer: GateResult;
    language_switching: GateResult;
    latency: GateResult;
    semantic_endpoint: GateResult;
    pi_runtime: GateResult;
    transcript_coverage?: GateResult;
  };
};

type CorrelationStatus = "evaluated" | "insufficient_data" | "insufficient_variation";

type QualityCorrelation = {
  status: CorrelationStatus;
  coefficient: number | null;
  case_count: number;
};

type QualityTagSlice = {
  case_count: number;
  observation_count: number;
  cer: number;
  comparison_case_count: number;
  comparison_observation_count: number;
  comparison_cer: number | null;
};

type QualityAnalysis = {
  status: "evaluated" | "partial" | "not_evaluated";
  source_profile: "baseline";
  independent_case_count: number;
  observation_count: number;
  audio_metrics_observation_count: number;
  confidence_observation_count: number;
  correlations: {
    rms_dbfs_vs_cer: QualityCorrelation;
    peak_dbfs_vs_cer: QualityCorrelation;
    clipped_sample_ratio_vs_cer: QualityCorrelation;
    near_silence_ratio_vs_cer: QualityCorrelation;
    dropped_packet_ratio_vs_cer: QualityCorrelation;
    original_confidence_mean_vs_cer: QualityCorrelation;
    original_confidence_min_vs_cer: QualityCorrelation;
  };
  tag_slices: Readonly<Record<string, QualityTagSlice>>;
  limitations: readonly string[];
};

export type SttEvaluationReport = {
  version: 1;
  generated_at: string;
  experiment: SttEvaluationExperiment;
  provider_environment?: NonNullable<SttEvaluationObservations["provider_environment"]>;
  profile_mapping: Readonly<Record<string, SttEvaluationProfile>>;
  profiles: Partial<Record<SttEvaluationProfile, ProfileScore>>;
  comparisons: Partial<Record<SttEvaluationProfile, ProfileComparison>>;
  quality_analysis: QualityAnalysis;
  preprocessing: {
    decision: "not_adopted";
    evidence_status:
      | "noise_not_primary_in_dataset"
      | "preprocessing_ab_required"
      | "not_evaluated";
    noise_tagged_case_count: number;
    noise_tagged_cer: number | null;
    non_noise_case_count: number;
    non_noise_cer: number | null;
    reason: string;
  };
};

function parsedOrThrow<T>(schema: z.ZodType<T>, json: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`${label}が有効なJSONではありません`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || label}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}が不正です: ${issues}`);
}

export function parseSttEvaluationManifest(json: string): SttEvaluationManifest {
  return parsedOrThrow(evaluationManifestSchema, json, "STT評価manifest");
}

export function parseSttEvaluationObservations(json: string): SttEvaluationObservations {
  return parsedOrThrow(evaluationObservationsSchema, json, "STT評価観測結果");
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").replace(/\p{White_Space}+/gu, "");
}

function normalizeTerm(value: string): string {
  return normalizeForComparison(value).toLocaleLowerCase("und");
}

function editDistance(left: readonly string[], right: readonly string[]): number {
  if (left.length > right.length) return editDistance(right, left);
  let previous = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    const current = [rightIndex];
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const substitution = previous[leftIndex - 1] ?? Number.POSITIVE_INFINITY;
      const deletion = previous[leftIndex] ?? Number.POSITIVE_INFINITY;
      const insertion = current[leftIndex - 1] ?? Number.POSITIVE_INFINITY;
      current.push(Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[left.length] ?? right.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("percentileには1件以上の値が必要です");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("percentileの計算に失敗しました");
  return value;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("meanには1件以上の値が必要です");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreCase(evaluationCase: SttEvaluationCase, result: SttEvaluationResult): CaseScore {
  const reference = Array.from(normalizeForComparison(evaluationCase.reference));
  const hypothesis = Array.from(normalizeForComparison(result.transcript));
  const characterEdits = editDistance(reference, hypothesis);
  const normalizedTranscript = normalizeTerm(result.transcript);
  const recalledTerms = evaluationCase.key_terms
    .filter((term) => normalizedTranscript.includes(normalizeTerm(term))).length;
  const expectedLanguages = new Set(evaluationCase.expected_languages);
  const recalledLanguages = new Set(result.recognized_languages
    .filter((language) => expectedLanguages.has(language))).size;
  return {
    trial: result.trial,
    case_id: evaluationCase.id,
    cer: characterEdits / reference.length,
    character_edits: characterEdits,
    reference_characters: reference.length,
    key_term_recall: evaluationCase.key_terms.length === 0
      ? null
      : recalledTerms / evaluationCase.key_terms.length,
    key_terms_recalled: recalledTerms,
    key_terms_expected: evaluationCase.key_terms.length,
    language_recall: recalledLanguages / expectedLanguages.size,
    languages_recalled: recalledLanguages,
    languages_expected: expectedLanguages.size,
    segment_count: result.segments.length,
    expected_segments: evaluationCase.expected_segments,
    unnatural_split_count: Math.max(0, result.segments.length - evaluationCase.expected_segments),
    decoded_packet_count: result.decoded_packet_count,
    dropped_packet_count: result.dropped_packet_count,
    dropped_packet_ratio: result.dropped_packet_count /
      (result.decoded_packet_count + result.dropped_packet_count),
    audio_metrics: result.audio_metrics ?? null,
    finalizations: result.finalizations.map((finalization) => ({
      kind: finalization.kind,
      reason: finalization.reason,
      latency_ms: finalization.latency_ms,
      has_text: finalization.has_text,
    })),
  };
}

function microCer(scores: readonly CaseScore[]): number {
  const referenceCharacters = scores.reduce((sum, score) => sum + score.reference_characters, 0);
  if (referenceCharacters === 0) throw new Error("CERの正解文字数が0です");
  return scores.reduce((sum, score) => sum + score.character_edits, 0) / referenceCharacters;
}

type QualityCase = {
  case_id: string;
  cer: number;
  rms_dbfs: number | null;
  peak_dbfs: number | null;
  clipped_sample_ratio: number | null;
  near_silence_ratio: number | null;
  dropped_packet_ratio: number;
  original_confidence_mean: number | null;
  original_confidence_min: number | null;
};

function meanNullable(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0 ? null : mean(measured);
}

function qualityCases(scores: readonly CaseScore[]): QualityCase[] {
  const scoresByCase = new Map<string, CaseScore[]>();
  for (const score of scores) {
    const entries = scoresByCase.get(score.case_id) ?? [];
    entries.push(score);
    scoresByCase.set(score.case_id, entries);
  }
  return [...scoresByCase].map(([caseId, entries]) => {
    const metrics = entries
      .map((entry) => entry.audio_metrics)
      .filter((entry): entry is SttEvaluationAudioMetrics => entry !== null);
    const confidenceTokenCount = metrics.reduce(
      (sum, metric) => sum + metric.original_token_count,
      0,
    );
    const confidenceWeightedSum = metrics.reduce((sum, metric) => (
      sum + (metric.original_confidence_mean ?? 0) * metric.original_token_count
    ), 0);
    const confidenceMinimums = metrics
      .map((metric) => metric.original_confidence_min)
      .filter((value): value is number => value !== null);
    const decodedPackets = entries.reduce((sum, entry) => sum + entry.decoded_packet_count, 0);
    const droppedPackets = entries.reduce((sum, entry) => sum + entry.dropped_packet_count, 0);
    return {
      case_id: caseId,
      cer: microCer(entries),
      rms_dbfs: meanNullable(metrics.map((metric) => metric.rms_dbfs)),
      peak_dbfs: meanNullable(metrics.map((metric) => metric.peak_dbfs)),
      clipped_sample_ratio: meanNullable(
        metrics.map((metric) => metric.clipped_sample_ratio),
      ),
      near_silence_ratio: meanNullable(metrics.map((metric) => metric.near_silence_ratio)),
      dropped_packet_ratio: droppedPackets / (decodedPackets + droppedPackets),
      original_confidence_mean: confidenceTokenCount === 0
        ? null
        : confidenceWeightedSum / confidenceTokenCount,
      original_confidence_min: confidenceMinimums.length === 0
        ? null
        : Math.min(...confidenceMinimums),
    };
  });
}

function correlation(
  cases: readonly QualityCase[],
  metric: (qualityCase: QualityCase) => number | null,
): QualityCorrelation {
  const pairs = cases.flatMap((qualityCase) => {
    const value = metric(qualityCase);
    return value === null ? [] : [{ value, cer: qualityCase.cer }];
  });
  if (pairs.length < 3) {
    return { status: "insufficient_data", coefficient: null, case_count: pairs.length };
  }
  const metricMean = mean(pairs.map((pair) => pair.value));
  const cerMean = mean(pairs.map((pair) => pair.cer));
  const numerator = pairs.reduce(
    (sum, pair) => sum + (pair.value - metricMean) * (pair.cer - cerMean),
    0,
  );
  const metricSquareSum = pairs.reduce(
    (sum, pair) => sum + (pair.value - metricMean) ** 2,
    0,
  );
  const cerSquareSum = pairs.reduce(
    (sum, pair) => sum + (pair.cer - cerMean) ** 2,
    0,
  );
  if (metricSquareSum === 0 || cerSquareSum === 0) {
    return {
      status: "insufficient_variation",
      coefficient: null,
      case_count: pairs.length,
    };
  }
  return {
    status: "evaluated",
    coefficient: Math.round(
      (numerator / Math.sqrt(metricSquareSum * cerSquareSum)) * 1_000_000,
    ) / 1_000_000,
    case_count: pairs.length,
  };
}

function createQualityAnalysis(
  manifest: SttEvaluationManifest,
  baseline: ProfileScore,
): QualityAnalysis {
  const caseIdsByTag = new Map<string, Set<string>>();
  for (const evaluationCase of manifest.cases) {
    for (const tag of evaluationCase.tags) {
      const caseIds = caseIdsByTag.get(tag) ?? new Set<string>();
      caseIds.add(evaluationCase.id);
      caseIdsByTag.set(tag, caseIds);
    }
  }
  const tagSlices: Record<string, QualityTagSlice> = {};
  for (const [tag, caseIds] of [...caseIdsByTag].sort(([left], [right]) => (
    left.localeCompare(right, "en")
  ))) {
    const tagged = baseline.cases.filter((score) => caseIds.has(score.case_id));
    const comparison = baseline.cases.filter((score) => !caseIds.has(score.case_id));
    tagSlices[tag] = {
      case_count: caseIds.size,
      observation_count: tagged.length,
      cer: microCer(tagged),
      comparison_case_count: manifest.cases.length - caseIds.size,
      comparison_observation_count: comparison.length,
      comparison_cer: comparison.length === 0 ? null : microCer(comparison),
    };
  }
  const cases = qualityCases(baseline.cases);
  const audioMetricsObservationCount = baseline.cases
    .filter((score) => score.audio_metrics !== null).length;
  const confidenceObservationCount = baseline.cases.filter((score) => (
    score.audio_metrics?.original_confidence_mean !== null &&
    score.audio_metrics?.original_confidence_mean !== undefined
  )).length;
  return {
    status: audioMetricsObservationCount === 0
      ? "not_evaluated"
      : audioMetricsObservationCount === baseline.observation_count
        ? "evaluated"
        : "partial",
    source_profile: "baseline",
    independent_case_count: cases.length,
    observation_count: baseline.observation_count,
    audio_metrics_observation_count: audioMetricsObservationCount,
    confidence_observation_count: confidenceObservationCount,
    correlations: {
      rms_dbfs_vs_cer: correlation(cases, (entry) => entry.rms_dbfs),
      peak_dbfs_vs_cer: correlation(cases, (entry) => entry.peak_dbfs),
      clipped_sample_ratio_vs_cer: correlation(
        cases,
        (entry) => entry.clipped_sample_ratio,
      ),
      near_silence_ratio_vs_cer: correlation(cases, (entry) => entry.near_silence_ratio),
      dropped_packet_ratio_vs_cer: correlation(cases, (entry) => entry.dropped_packet_ratio),
      original_confidence_mean_vs_cer: correlation(
        cases,
        (entry) => entry.original_confidence_mean,
      ),
      original_confidence_min_vs_cer: correlation(
        cases,
        (entry) => entry.original_confidence_min,
      ),
    },
    tag_slices: tagSlices,
    limitations: [
      "同一人工音声の複数試行は独立標本とみなさず、相関係数はcase単位へ集約しています。",
      "相関係数は因果関係を示しません。少数caseの結果は実Discord音声で再確認が必要です。",
      "packet欠落がない、または指標が一定の場合は相関を評価できません。",
      ...(confidenceObservationCount < baseline.observation_count
        ? ["原文tokenが返らずconfidenceを取得できない観測は、confidenceとCERの相関から除外しています。"]
        : []),
    ],
  };
}

function createPreprocessingDecision(
  qualityAnalysis: QualityAnalysis,
): SttEvaluationReport["preprocessing"] {
  const noise = qualityAnalysis.tag_slices.noise;
  const noiseCer = noise?.cer ?? null;
  const nonNoiseCer = noise?.comparison_cer ?? null;
  if (!noise || noiseCer === null || nonNoiseCer === null) {
    return {
      decision: "not_adopted",
      evidence_status: "not_evaluated",
      noise_tagged_case_count: noise?.case_count ?? 0,
      noise_tagged_cer: noiseCer,
      non_noise_case_count: noise?.comparison_case_count ?? 0,
      non_noise_cer: nonNoiseCer,
      reason: "noiseタグと非noise音声の両方が揃っていないため、前処理を標準採用しません。",
    };
  }
  if (noiseCer <= nonNoiseCer) {
    return {
      decision: "not_adopted",
      evidence_status: "noise_not_primary_in_dataset",
      noise_tagged_case_count: noise.case_count,
      noise_tagged_cer: noiseCer,
      non_noise_case_count: noise.comparison_case_count,
      non_noise_cer: nonNoiseCer,
      reason: "同一人工音声ではnoiseタグのCERが非noise音声を上回らず、ノイズが主要因という根拠がないため、RNNoise等を標準採用しません。",
    };
  }
  return {
    decision: "not_adopted",
    evidence_status: "preprocessing_ab_required",
    noise_tagged_case_count: noise.case_count,
    noise_tagged_cer: noiseCer,
    non_noise_case_count: noise.comparison_case_count,
    non_noise_cer: nonNoiseCer,
    reason: "noiseタグのCERが高いため、前処理なしとのA/B評価で10%以上の改善とクリーン音声の非悪化を確認するまで標準採用しません。",
  };
}

function aggregateRatio(
  scores: readonly CaseScore[],
  numerator: "key_terms_recalled" | "languages_recalled",
  denominator: "key_terms_expected" | "languages_expected",
): number | null {
  const expected = scores.reduce((sum, score) => sum + score[denominator], 0);
  if (expected === 0) return null;
  return scores.reduce((sum, score) => sum + score[numerator], 0) / expected;
}

function scoreProfile(
  manifest: SttEvaluationManifest,
  results: readonly SttEvaluationResult[],
): ProfileScore {
  const profile = results[0]?.profile ?? "unknown";
  const trialIds = [...new Set(results.map((result) => result.trial))]
    .sort((left, right) => left - right);
  for (const [index, trial] of trialIds.entries()) {
    if (trial !== index + 1) {
      throw new Error(`profile「${profile}」のtrialは1から連続させてください`);
    }
  }
  const byTrialAndCase = new Map(results.map((result) => [
    `${String(result.trial)}\u0000${result.case_id}`,
    result,
  ]));
  const cases = trialIds.flatMap((trial) => manifest.cases.map((evaluationCase) => {
    const result = byTrialAndCase.get(`${String(trial)}\u0000${evaluationCase.id}`);
    if (!result) {
      throw new Error(
        `profile「${profile}」のtrial「${String(trial)}」にcase「${evaluationCase.id}」がありません`,
      );
    }
    return scoreCase(evaluationCase, result);
  }));
  if (cases.length !== results.length) {
    throw new Error(`profile「${profile}」の試行結果件数がmanifestと一致しません`);
  }
  const cleanIds = new Set(manifest.cases
    .filter((evaluationCase) => evaluationCase.tags.includes("clean"))
    .map((evaluationCase) => evaluationCase.id));
  const cleanCases = cases.filter((score) => cleanIds.has(score.case_id));
  const switchIds = new Set(manifest.cases
    .filter((evaluationCase) => evaluationCase.tags.includes("code-switch"))
    .map((evaluationCase) => evaluationCase.id));
  const switchCases = cases.filter((score) => switchIds.has(score.case_id));
  const measuredFinalizations = results.flatMap((result) => {
    const textBoundaries = result.finalizations.filter((finalization) => finalization.has_text);
    return textBoundaries.length > 0 ? textBoundaries : result.finalizations.slice(-1);
  });
  const latencies = measuredFinalizations.map((finalization) => finalization.latency_ms);
  const observedFinalizations = results.flatMap((result) => result.finalizations);
  const sonioxEndpointCount = measuredFinalizations
    .filter((finalization) => finalization.reason === "soniox_endpoint").length;
  const manualFallbackCount = measuredFinalizations.filter((finalization) => (
    finalization.reason === "speaking_end" ||
    finalization.reason === "transcript_inactivity" ||
    finalization.reason === "max_turn_duration"
  )).length;
  const cpu = results.map((result) => result.cpu_percent);
  const decodedPackets = results.map((result) => result.decoded_packet_count);
  const droppedPackets = results.map((result) => result.dropped_packet_count);
  const packetTotal = [...decodedPackets, ...droppedPackets]
    .reduce((sum, value) => sum + value, 0);
  const configuration = results[0]?.configuration;
  if (!configuration) throw new Error("STT評価profileのconfigurationがありません");
  return {
    case_count: manifest.cases.length,
    trial_count: trialIds.length,
    observation_count: cases.length,
    preprocessing: "none",
    configuration,
    cer: microCer(cases),
    clean_cer: cleanCases.length === 0 ? null : microCer(cleanCases),
    key_term_recall: aggregateRatio(cases, "key_terms_recalled", "key_terms_expected"),
    language_recall: aggregateRatio(cases, "languages_recalled", "languages_expected") ?? 0,
    language_switch_recall: switchCases.length === 0
      ? null
      : aggregateRatio(switchCases, "languages_recalled", "languages_expected"),
    code_switch_cer: switchCases.length === 0 ? null : microCer(switchCases),
    unnatural_split_count: cases.reduce((sum, score) => sum + score.unnatural_split_count, 0),
    latency_ms: {
      mean: mean(latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    finalization: {
      observed_boundary_count: observedFinalizations.length,
      adoption_boundary_count: measuredFinalizations.length,
      observed_endpoint_count: observedFinalizations
        .filter((finalization) => finalization.kind === "endpoint").length,
      observed_finalized_count: observedFinalizations
        .filter((finalization) => finalization.kind === "finalized").length,
      soniox_endpoint_count: sonioxEndpointCount,
      manual_fallback_count: manualFallbackCount,
      soniox_endpoint_ratio: sonioxEndpointCount / measuredFinalizations.length,
    },
    cpu_percent: { mean: mean(cpu), p95: percentile(cpu, 0.95) },
    packets: {
      decoded_mean: mean(decodedPackets),
      dropped_mean: mean(droppedPackets),
      dropped_ratio: packetTotal === 0
        ? 0
        : droppedPackets.reduce((sum, value) => sum + value, 0) / packetTotal,
    },
    cases,
  };
}

function gate(condition: boolean): GateResult {
  return condition ? "pass" : "fail";
}

function isSonioxConfiguration(
  configuration: SttEvaluationConfiguration,
): configuration is z.infer<typeof sonioxSttEvaluationConfigurationSchema> {
  return !("provider" in configuration);
}

function transcriptCoverage(results: readonly SttEvaluationResult[]): number {
  return results.filter((result) => result.transcript.trim().length > 0).length / results.length;
}

function compareProfile(
  baseline: ProfileScore,
  candidate: ProfileScore,
  baselineResults: readonly SttEvaluationResult[],
  candidateResults: readonly SttEvaluationResult[],
): ProfileComparison {
  if (baseline.trial_count !== candidate.trial_count) {
    throw new Error("baselineと候補profileのtrial数が一致しません");
  }
  const relativeCer = baseline.cer === 0
    ? null
    : (baseline.cer - candidate.cer) / baseline.cer * 100;
  const keyTermChange = baseline.key_term_recall === null || candidate.key_term_recall === null
    ? null
    : candidate.key_term_recall - baseline.key_term_recall;
  const cleanCerChange = baseline.clean_cer === null || candidate.clean_cer === null
    ? null
    : (candidate.clean_cer - baseline.clean_cer) * 100;
  const languageSwitchChange = baseline.language_switch_recall === null ||
      candidate.language_switch_recall === null
    ? null
    : candidate.language_switch_recall - baseline.language_switch_recall;
  const codeSwitchCerChange = baseline.code_switch_cer === null ||
      candidate.code_switch_cer === null
    ? null
    : (candidate.code_switch_cer - baseline.code_switch_cer) * 100;
  const addedLatency = candidate.latency_ms.p95 - baseline.latency_ms.p95;
  const comparesDifferentProvider = !isSonioxConfiguration(candidate.configuration);
  const baselineTranscriptCoverage = transcriptCoverage(baselineResults);
  const candidateTranscriptCoverage = transcriptCoverage(candidateResults);
  const transcriptCoverageChange = candidateTranscriptCoverage - baselineTranscriptCoverage;
  return {
    cer_relative_improvement_percent: relativeCer,
    key_term_recall_change: keyTermChange,
    clean_cer_point_change: cleanCerChange,
    language_switch_recall_change: languageSwitchChange,
    code_switch_cer_point_change: codeSwitchCerChange,
    p95_added_latency_ms: addedLatency,
    ...(comparesDifferentProvider
      ? {
          baseline_transcript_coverage: baselineTranscriptCoverage,
          candidate_transcript_coverage: candidateTranscriptCoverage,
          transcript_coverage_change: transcriptCoverageChange,
        }
      : {}),
    gates: {
      overall_cer: relativeCer === null ? "not_evaluated" : gate(relativeCer >= 10),
      key_terms: keyTermChange === null ? "not_evaluated" : gate(keyTermChange > 0),
      clean_cer: cleanCerChange === null ? "not_evaluated" : gate(cleanCerChange < 1),
      language_switching: codeSwitchCerChange === null
        ? "not_evaluated"
        : languageSwitchChange === null
          ? "not_evaluated"
          : gate(codeSwitchCerChange <= 0 && languageSwitchChange >= 0),
      latency: gate(addedLatency <= 200),
      semantic_endpoint: isSonioxConfiguration(candidate.configuration) &&
          candidate.configuration.endpoint_mode !== "manual_early"
        ? gate(candidate.finalization.soniox_endpoint_ratio > 0.5)
        : "not_evaluated",
      pi_runtime: "not_evaluated",
      ...(comparesDifferentProvider
        ? { transcript_coverage: gate(transcriptCoverageChange >= 0) }
        : {}),
    },
  };
}

export function createSttEvaluationReport(
  manifest: SttEvaluationManifest,
  observations: SttEvaluationObservations,
  generatedAt = new Date(),
): SttEvaluationReport {
  const knownCaseIds = new Set(manifest.cases.map((evaluationCase) => evaluationCase.id));
  for (const result of observations.results) {
    if (!knownCaseIds.has(result.case_id)) {
      throw new Error(`STT評価観測結果に未知のcase「${result.case_id}」があります`);
    }
  }
  const profiles: Partial<Record<SttEvaluationProfile, ProfileScore>> = {};
  const profileMapping = sttEvaluationExperimentProfileMappings[observations.experiment];
  const experimentProfiles = Object.values(profileMapping);
  const allowedProfiles = new Set<SttEvaluationProfile>(experimentProfiles);
  for (const result of observations.results) {
    if (!allowedProfiles.has(result.profile)) {
      throw new Error(
        `experiment「${observations.experiment}」にprofile「${result.profile}」は含まれません`,
      );
    }
  }
  for (const profile of experimentProfiles) {
    const results = observations.results.filter((result) => result.profile === profile);
    if (results.length > 0) profiles[profile] = scoreProfile(manifest, results);
  }
  const baseline = profiles.baseline;
  if (!baseline) throw new Error("STT評価観測結果にはbaseline profileが必要です");
  const comparisons: SttEvaluationReport["comparisons"] = {};
  for (const profile of experimentProfiles.filter((profile) => profile !== "baseline")) {
    const candidate = profiles[profile];
    if (candidate) {
      comparisons[profile] = compareProfile(
        baseline,
        candidate,
        observations.results.filter((result) => result.profile === "baseline"),
        observations.results.filter((result) => result.profile === profile),
      );
    }
  }
  const qualityAnalysis = createQualityAnalysis(manifest, baseline);
  return {
    version: 1,
    generated_at: generatedAt.toISOString(),
    experiment: observations.experiment,
    ...(observations.provider_environment === undefined
      ? {}
      : { provider_environment: observations.provider_environment }),
    profile_mapping: profileMapping,
    profiles,
    comparisons,
    quality_analysis: qualityAnalysis,
    preprocessing: createPreprocessingDecision(qualityAnalysis),
  };
}
