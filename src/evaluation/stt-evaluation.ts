import { z } from "zod";

import { languagePairs } from "../domain/language-pair.js";

const evaluationLanguageSchema = z.enum(["ja", "ko"]);
const evaluationProfileSchema = z.enum([
  "baseline",
  "context",
  "endpoint",
  "context_endpoint",
]);
const sttEvaluationConfigurationSchema = z.object({
  recognition_context_enabled: z.boolean(),
  endpoint_mode: z.enum(["manual_early", "soniox_primary"]),
  discord_speaking_end_delay_ms: z.number().int().nonnegative(),
  manual_finalize_fallback_ms: z.number().int().nonnegative(),
  soniox_max_endpoint_delay_ms: z.number().int().positive(),
  preprocessing: z.literal("none"),
}).strict();
export type SttEvaluationConfiguration = z.infer<typeof sttEvaluationConfigurationSchema>;

export const sttEvaluationProfileConfigurations = {
  baseline: {
    recognition_context_enabled: false,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    preprocessing: "none",
  },
  context: {
    recognition_context_enabled: true,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: 2_000,
    preprocessing: "none",
  },
  endpoint: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
    preprocessing: "none",
  },
  context_endpoint: {
    recognition_context_enabled: true,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: 100,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
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

const evaluationResultSchema = z.object({
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
    ]),
    latency_ms: z.number().nonnegative(),
    has_text: z.boolean(),
  }).strict()).min(1),
  cpu_percent: z.number().nonnegative(),
  decoded_packet_count: z.number().int().positive(),
  dropped_packet_count: z.number().int().nonnegative(),
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
const evaluationObservationsSchema = z.object({
  version: z.literal(1),
  dataset: evaluationDatasetEvidenceSchema.optional(),
  results: z.array(evaluationResultSchema).min(1),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, result] of value.results.entries()) {
    const key = `${result.profile}\u0000${result.case_id}`;
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["results", index],
        message: `profileとcase_idの組「${result.profile}/${result.case_id}」が重複しています`,
      });
    }
    keys.add(key);
  }
});

export type SttEvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type SttEvaluationObservations = z.infer<typeof evaluationObservationsSchema>;
export type SttEvaluationProfile = z.infer<typeof evaluationProfileSchema>;
type SttEvaluationCase = SttEvaluationManifest["cases"][number];
type SttEvaluationResult = SttEvaluationObservations["results"][number];

export const sttEvaluationProfileMapping = {
  A: "baseline",
  B: "context",
  C: "endpoint",
  D: "context_endpoint",
} as const satisfies Readonly<Record<string, SttEvaluationProfile>>;

type GateResult = "pass" | "fail" | "not_evaluated";

type CaseScore = {
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
};

type ProfileScore = {
  case_count: number;
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
    boundary_count: number;
    endpoint_count: number;
    finalized_count: number;
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
  gates: {
    overall_cer: GateResult;
    key_terms: GateResult;
    clean_cer: GateResult;
    language_switching: GateResult;
    latency: GateResult;
    semantic_endpoint: GateResult;
    pi_runtime: GateResult;
  };
};

export type SttEvaluationReport = {
  version: 1;
  generated_at: string;
  profile_mapping: typeof sttEvaluationProfileMapping;
  profiles: Partial<Record<SttEvaluationProfile, ProfileScore>>;
  comparisons: Partial<Record<Exclude<SttEvaluationProfile, "baseline">, ProfileComparison>>;
  preprocessing: {
    decision: "not_adopted";
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
  };
}

function microCer(scores: readonly CaseScore[]): number {
  const referenceCharacters = scores.reduce((sum, score) => sum + score.reference_characters, 0);
  if (referenceCharacters === 0) throw new Error("CERの正解文字数が0です");
  return scores.reduce((sum, score) => sum + score.character_edits, 0) / referenceCharacters;
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
  const byCase = new Map(results.map((result) => [result.case_id, result]));
  const cases = manifest.cases.map((evaluationCase) => {
    const result = byCase.get(evaluationCase.id);
    if (!result) throw new Error(`profile「${results[0]?.profile ?? "unknown"}」にcase「${evaluationCase.id}」がありません`);
    return scoreCase(evaluationCase, result);
  });
  if (byCase.size !== manifest.cases.length) {
    const known = new Set(manifest.cases.map((evaluationCase) => evaluationCase.id));
    const unknown = [...byCase.keys()].find((caseId) => !known.has(caseId));
    throw new Error(`STT評価観測結果に未知のcase「${unknown ?? "unknown"}」があります`);
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
  const finalizations = results.flatMap((result) => result.finalizations);
  const sonioxEndpointCount = finalizations
    .filter((finalization) => finalization.reason === "soniox_endpoint").length;
  const manualFallbackCount = finalizations.filter((finalization) => (
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
    case_count: cases.length,
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
      boundary_count: finalizations.length,
      endpoint_count: finalizations
        .filter((finalization) => finalization.kind === "endpoint").length,
      finalized_count: finalizations
        .filter((finalization) => finalization.kind === "finalized").length,
      soniox_endpoint_count: sonioxEndpointCount,
      manual_fallback_count: manualFallbackCount,
      soniox_endpoint_ratio: sonioxEndpointCount / finalizations.length,
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

function compareProfile(baseline: ProfileScore, candidate: ProfileScore): ProfileComparison {
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
  return {
    cer_relative_improvement_percent: relativeCer,
    key_term_recall_change: keyTermChange,
    clean_cer_point_change: cleanCerChange,
    language_switch_recall_change: languageSwitchChange,
    code_switch_cer_point_change: codeSwitchCerChange,
    p95_added_latency_ms: addedLatency,
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
      semantic_endpoint: candidate.configuration.endpoint_mode === "soniox_primary"
        ? gate(candidate.finalization.soniox_endpoint_ratio > 0.5)
        : "not_evaluated",
      pi_runtime: "not_evaluated",
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
  for (const profile of evaluationProfileSchema.options) {
    const results = observations.results.filter((result) => result.profile === profile);
    if (results.length > 0) profiles[profile] = scoreProfile(manifest, results);
  }
  const baseline = profiles.baseline;
  if (!baseline) throw new Error("STT評価観測結果にはbaseline profileが必要です");
  const comparisons: SttEvaluationReport["comparisons"] = {};
  for (const profile of ["context", "endpoint", "context_endpoint"] as const) {
    const candidate = profiles[profile];
    if (candidate) comparisons[profile] = compareProfile(baseline, candidate);
  }
  return {
    version: 1,
    generated_at: generatedAt.toISOString(),
    profile_mapping: sttEvaluationProfileMapping,
    profiles,
    comparisons,
    preprocessing: {
      decision: "not_adopted",
      reason: "前処理なしを基準とし、ノイズ音声のCER改善とクリーン音声の非悪化を実測するまで標準採用しません。",
    },
  };
}
