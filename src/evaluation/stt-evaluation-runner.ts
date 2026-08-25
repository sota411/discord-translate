import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  SonioxNodeClient,
  type RealtimeResult,
} from "@soniox/node";

import {
  SttTurnFinalizer,
  type SttAcceptedFinalizeReason,
  type SttBoundaryKind,
} from "../audio/stt-turn-finalizer.js";
import { SonioxSttFactory } from "../soniox/control.js";
import { createSttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import type {
  LoadedSttEvaluationCase,
  LoadedSttEvaluationDataset,
} from "./stt-evaluation-files.js";
import type {
  SttEvaluationExperiment,
  SttEvaluationObservations,
  SttEvaluationProfile,
} from "./stt-evaluation.js";
import {
  sttEvaluationExperimentProfileMappings,
  sttEvaluationProfileConfigurations,
} from "./stt-evaluation.js";

const transcriptInactivityMs = 3_000;
const maxTurnMs = 30_000;
const trailingSilenceMs = 200;
const maximumTrialCount = 10;
const endpointOnlyProbeTrialCount = 3;
const defaultBoundaryTimeoutMs = 10_000;
const defaultFinishTimeoutMs = 10_000;
const pcmSampleRate = 48_000;
const pcmBytesPerSample = 2;

type SttEvaluationRunResult = SttEvaluationObservations["results"][number] & {
  configuration: typeof sttEvaluationProfileConfigurations[SttEvaluationProfile];
};

export type SttEvaluationRunObservations = Omit<SttEvaluationObservations, "dataset" | "results"> & {
  dataset: NonNullable<SttEvaluationObservations["dataset"]>;
  results: SttEvaluationRunResult[];
};

export type SttEvaluationRunnerOptions = {
  apiKey: string;
  model: string;
  sttWebSocketUrl: string;
  experiment?: SttEvaluationExperiment;
  profiles?: readonly SttEvaluationProfile[];
  trials?: number;
  boundaryTimeoutMs?: number;
  finishTimeoutMs?: number;
};

export type SttEndpointOnlyProbeOptions = Pick<
  SttEvaluationRunnerOptions,
  "apiKey" | "model" | "sttWebSocketUrl" | "boundaryTimeoutMs" | "finishTimeoutMs"
> & {
  requiredCaseId: string;
  trials?: number;
};

export type SttEndpointOnlyProbeSummary = {
  version: 1;
  generated_at: string;
  experiment: "endpoint_timing";
  profile: "endpoint_only_1000";
  configuration: typeof sttEvaluationProfileConfigurations.endpoint_only_1000;
  dataset: {
    manifest_sha256: string;
    case: ReturnType<typeof createSttEvaluationDatasetEvidence>["cases"][number];
  };
  trials: ({
    trial: number;
    outcome: "boundary_timeout";
    boundary_timeout_ms: number;
    elapsed_ms: number;
    cpu_percent: number;
  } | {
    trial: number;
    outcome: "endpoint_observed";
    boundary_timeout_ms: number;
    elapsed_ms: number;
    cpu_percent: number;
    endpoint_latency_ms: number;
  })[];
  outcome: "repeated_boundary_timeout" | "endpoint_observed";
  full_dataset_scoring_completed: false;
  observations_written: false;
  decision: "not_adopted" | "full_dataset_evaluation_required";
  scope: string;
};

class SttEvaluationBoundaryTimeoutError extends Error {}

function isEvaluationLanguage(value: string | undefined): value is "ja" | "ko" {
  return value === "ja" || value === "ko";
}

async function waitUntil(startedAt: number, targetOffsetMs: number): Promise<void> {
  const remainingMs = targetOffsetMs - (performance.now() - startedAt);
  if (remainingMs > 0) await delay(remainingMs);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: string | Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(
      typeof timeoutError === "string" ? new Error(timeoutError) : timeoutError,
    ), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cpuPercent(startedAt: number, initialUsage: NodeJS.CpuUsage): number {
  const elapsedMicroseconds = Math.max((performance.now() - startedAt) * 1_000, 1);
  const usage = process.cpuUsage(initialUsage);
  return (usage.user + usage.system) / elapsedMicroseconds * 100;
}

async function runCase(
  client: SonioxNodeClient,
  dataset: LoadedSttEvaluationDataset,
  evaluationCase: LoadedSttEvaluationCase,
  trial: number,
  profile: SttEvaluationProfile,
  model: string,
  boundaryTimeoutMs: number,
  finishTimeoutMs: number,
): Promise<SttEvaluationRunResult> {
  const configuration = sttEvaluationProfileConfigurations[profile];
  const manualSafetyEnabled = configuration.endpoint_mode !== "soniox_only";
  const contextFactory = new SonioxSttFactory(
    client,
    model,
    configuration.recognition_context_enabled,
    configuration.endpoint_mode !== "manual_early"
      ? {
        maxEndpointDelayMs: configuration.soniox_max_endpoint_delay_ms,
        ...(configuration.soniox_endpoint_latency_adjustment_level === null
          ? {}
          : {
            endpointLatencyAdjustmentLevel:
              configuration.soniox_endpoint_latency_adjustment_level,
          }),
        ...(configuration.soniox_endpoint_sensitivity === null
          ? {}
          : { endpointSensitivity: configuration.soniox_endpoint_sensitivity }),
      }
      : {},
  );
  const { session } = contextFactory.create(
    dataset.manifest.pair,
    `stt-eval-${randomUUID()}`,
    evaluationCase.definition.translation_terms,
  );
  const boundary = Promise.withResolvers<undefined>();
  const recognizedLanguages = new Set<"ja" | "ko">();
  const segments: string[] = [];
  const finalizations: SttEvaluationRunResult["finalizations"] = [];
  let pendingText = "";
  let lastAudioAt: number | undefined;
  let lastPacketSent = false;
  let speakingEndTimer: NodeJS.Timeout | undefined;
  let endpointSilenceTimer: NodeJS.Timeout | undefined;
  const endpointSilenceChunk = configuration.endpoint_silence_chunk_ms === null
    ? undefined
    : Buffer.alloc(Math.round(
      pcmSampleRate * pcmBytesPerSample * configuration.endpoint_silence_chunk_ms / 1_000,
    ));
  const speakingEndSilence = configuration.endpoint_silence_chunk_ms === null
    ? undefined
    : Buffer.alloc(Math.round(
      pcmSampleRate * pcmBytesPerSample * configuration.discord_speaking_end_delay_ms / 1_000,
    ));

  const clearEndpointSilence = (): void => {
    if (!endpointSilenceTimer) return;
    clearTimeout(endpointSilenceTimer);
    endpointSilenceTimer = undefined;
  };
  const scheduleEndpointSilence = (): void => {
    const chunkMs = configuration.endpoint_silence_chunk_ms;
    if (chunkMs === null || endpointSilenceChunk === undefined || endpointSilenceTimer) return;
    endpointSilenceTimer = setTimeout(() => {
      endpointSilenceTimer = undefined;
      try {
        session.sendAudio(endpointSilenceChunk);
        scheduleEndpointSilence();
      } catch (error) {
        boundary.reject(error);
      }
    }, chunkMs);
    endpointSilenceTimer.unref();
  };
  const startEndpointSilence = (): void => {
    if (speakingEndSilence === undefined) return;
    try {
      session.sendAudio(speakingEndSilence);
      scheduleEndpointSilence();
    } catch (error) {
      boundary.reject(error);
    }
  };
  const finalizer = new SttTurnFinalizer({
    session,
    speakingEndDelayMs: configuration.manual_finalize_fallback_ms ?? 0,
    transcriptInactivityMs,
    maxTurnMs,
    trailingSilenceMs,
    onFinalize: clearEndpointSilence,
    onError: boundary.reject,
  });

  const handleResult = (result: RealtimeResult): void => {
    if (manualSafetyEnabled && result.tokens.length > 0) finalizer.transcriptProgressed();
    for (const token of result.tokens) {
      if (!token.is_final || token.translation_status !== "original") continue;
      pendingText += token.text;
      if (isEvaluationLanguage(token.language)) recognizedLanguages.add(token.language);
    }
  };
  const handleBoundary = (kind: SttBoundaryKind): void => {
    if (!finalizer.boundaryReceived(kind)) return;
    clearEndpointSilence();
    const reason: SttAcceptedFinalizeReason | undefined = finalizer.takeAcceptedFinalizeReason();
    if (!reason) {
      boundary.reject(new Error("受理したSTT境界の確定理由を取得できませんでした"));
      return;
    }
    const hasText = pendingText.trim().length > 0;
    if (hasText) {
      segments.push(pendingText);
      pendingText = "";
    }
    if (lastAudioAt !== undefined) {
      finalizations.push({
        kind,
        reason,
        latency_ms: Math.max(0, performance.now() - lastAudioAt),
        has_text: hasText,
      });
    }
    if (lastPacketSent) boundary.resolve(undefined);
  };
  session.on("result", handleResult);
  session.on("endpoint", () => handleBoundary("endpoint"));
  session.on("finalized", () => handleBoundary("finalized"));
  session.on("error", boundary.reject);

  let finished = false;
  try {
    await session.connect();
    const measurementStartedAt = performance.now();
    const initialCpuUsage = process.cpuUsage();
    const replayStartedAt = performance.now();
    for (const [index, packet] of evaluationCase.packets.entries()) {
      await waitUntil(replayStartedAt, packet.atMs);
      if (speakingEndTimer) clearTimeout(speakingEndTimer);
      clearEndpointSilence();
      if (manualSafetyEnabled) finalizer.speakingStarted();
      lastAudioAt = performance.now();
      lastPacketSent = index === evaluationCase.packets.length - 1;
      session.sendAudio(packet.audio);
      if (manualSafetyEnabled) finalizer.audioReceived();
      speakingEndTimer = setTimeout(() => {
        speakingEndTimer = undefined;
        startEndpointSilence();
        if (configuration.manual_finalize_fallback_ms !== null) {
          finalizer.speakingEnded();
        }
      }, configuration.discord_speaking_end_delay_ms);
    }

    await withTimeout(
      boundary.promise,
      boundaryTimeoutMs,
      new SttEvaluationBoundaryTimeoutError(
        `trial「${String(trial)}」case「${evaluationCase.definition.id}」profile「${profile}」の発話確定がtimeoutしました`,
      ),
    );
    const measuredCpuPercent = cpuPercent(measurementStartedAt, initialCpuUsage);
    if (speakingEndTimer) {
      clearTimeout(speakingEndTimer);
      speakingEndTimer = undefined;
    }
    finalizer.close();
    await withTimeout(
      session.finish(),
      finishTimeoutMs,
      `trial「${String(trial)}」case「${evaluationCase.definition.id}」profile「${profile}」の終了応答がtimeoutしました`,
    );
    finished = true;
    if (pendingText.trim().length > 0) segments.push(pendingText);
    if (finalizations.length === 0) {
      throw new Error(
        `trial「${String(trial)}」case「${evaluationCase.definition.id}」profile「${profile}」の確定遅延を取得できませんでした`,
      );
    }
    return {
      trial,
      case_id: evaluationCase.definition.id,
      profile,
      transcript: segments.join(""),
      segments,
      recognized_languages: [...recognizedLanguages],
      finalizations,
      cpu_percent: measuredCpuPercent,
      decoded_packet_count: evaluationCase.packets.length,
      dropped_packet_count: evaluationCase.droppedPacketCount,
      configuration,
    };
  } finally {
    if (speakingEndTimer) clearTimeout(speakingEndTimer);
    clearEndpointSilence();
    finalizer.close();
    if (!finished) session.close();
  }
}

export async function runSttEvaluationDataset(
  dataset: LoadedSttEvaluationDataset,
  options: SttEvaluationRunnerOptions,
): Promise<SttEvaluationRunObservations> {
  if (options.apiKey.trim().length === 0) throw new Error("Soniox API keyが空です");
  if (options.model.trim().length === 0) throw new Error("Soniox STT modelが空です");
  if (options.sttWebSocketUrl.trim().length === 0) throw new Error("Soniox STT WebSocket URLが空です");
  const experiment = options.experiment ?? "context_endpoint";
  const experimentProfiles = Object.values(sttEvaluationExperimentProfileMappings[experiment]);
  const profiles = options.profiles ?? experimentProfiles.filter(
    (profile) => profile !== "endpoint_only_1000",
  );
  if (profiles.length === 0 || new Set(profiles).size !== profiles.length) {
    throw new Error("STT評価profileは重複なしで1件以上指定してください");
  }
  const allowedProfiles = new Set<SttEvaluationProfile>(experimentProfiles);
  const invalidProfile = profiles.find((profile) => !allowedProfiles.has(profile));
  if (invalidProfile) {
    throw new Error(`experiment「${experiment}」にprofile「${invalidProfile}」は含まれません`);
  }
  const trials = options.trials ?? 1;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > maximumTrialCount) {
    throw new Error(`STT評価trial数は1〜${String(maximumTrialCount)}の整数にしてください`);
  }
  const boundaryTimeoutMs = options.boundaryTimeoutMs ?? defaultBoundaryTimeoutMs;
  const finishTimeoutMs = options.finishTimeoutMs ?? defaultFinishTimeoutMs;
  if (
    !Number.isSafeInteger(boundaryTimeoutMs) || boundaryTimeoutMs <= 0 ||
    !Number.isSafeInteger(finishTimeoutMs) || finishTimeoutMs <= 0
  ) {
    throw new Error("STT評価timeoutは正の整数にしてください");
  }
  const client = new SonioxNodeClient({
    api_key: options.apiKey,
    realtime: { ws_base_url: options.sttWebSocketUrl },
  });
  const results: SttEvaluationRunResult[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const [caseIndex, evaluationCase] of dataset.cases.entries()) {
      const profileStartIndex = (trial - 1 + caseIndex) % profiles.length;
      for (let offset = 0; offset < profiles.length; offset += 1) {
        const profile = profiles[(profileStartIndex + offset) % profiles.length];
        if (!profile) throw new Error("STT評価profileの実行順を解決できませんでした");
        results.push(await runCase(
          client,
          dataset,
          evaluationCase,
          trial,
          profile,
          options.model,
          boundaryTimeoutMs,
          finishTimeoutMs,
        ));
      }
    }
  }
  return {
    version: 1,
    experiment,
    dataset: createSttEvaluationDatasetEvidence(dataset),
    results,
  };
}

export async function runSttEndpointOnlyProbe(
  dataset: LoadedSttEvaluationDataset,
  options: SttEndpointOnlyProbeOptions,
): Promise<SttEndpointOnlyProbeSummary> {
  if (options.apiKey.trim().length === 0) throw new Error("Soniox API keyが空です");
  if (options.model.trim().length === 0) throw new Error("Soniox STT modelが空です");
  if (options.sttWebSocketUrl.trim().length === 0) {
    throw new Error("Soniox STT WebSocket URLが空です");
  }
  const trials = options.trials ?? endpointOnlyProbeTrialCount;
  if (trials !== endpointOnlyProbeTrialCount) {
    throw new Error(
      `endpoint-only probeは${String(endpointOnlyProbeTrialCount)}試行で実行してください`,
    );
  }
  const boundaryTimeoutMs = options.boundaryTimeoutMs ?? defaultBoundaryTimeoutMs;
  const finishTimeoutMs = options.finishTimeoutMs ?? defaultFinishTimeoutMs;
  if (
    !Number.isSafeInteger(boundaryTimeoutMs) || boundaryTimeoutMs <= 0 ||
    !Number.isSafeInteger(finishTimeoutMs) || finishTimeoutMs <= 0
  ) {
    throw new Error("STT評価timeoutは正の整数にしてください");
  }
  const evaluationCase = dataset.cases.find(
    (candidate) => candidate.definition.id === options.requiredCaseId,
  );
  if (!evaluationCase) {
    throw new Error(`必須case「${options.requiredCaseId}」がmanifestにありません`);
  }
  const datasetEvidence = createSttEvaluationDatasetEvidence(dataset);
  const caseEvidence = datasetEvidence.cases.find(
    (candidate) => candidate.case_id === options.requiredCaseId,
  );
  if (!caseEvidence) throw new Error("必須caseのdataset証拠を解決できませんでした");

  const client = new SonioxNodeClient({
    api_key: options.apiKey,
    realtime: { ws_base_url: options.sttWebSocketUrl },
  });
  const probeTrials: SttEndpointOnlyProbeSummary["trials"] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    const startedAt = performance.now();
    const initialCpuUsage = process.cpuUsage();
    try {
      const result = await runCase(
        client,
        dataset,
        evaluationCase,
        trial,
        "endpoint_only_1000",
        options.model,
        boundaryTimeoutMs,
        finishTimeoutMs,
      );
      const endpointFinalization = result.finalizations.find(
        (finalization) => finalization.reason === "soniox_endpoint",
      );
      if (!endpointFinalization) {
        throw new Error(
          `trial「${String(trial)}」でSoniox endpointの確定結果を取得できませんでした`,
        );
      }
      probeTrials.push({
        trial,
        outcome: "endpoint_observed",
        boundary_timeout_ms: boundaryTimeoutMs,
        elapsed_ms: performance.now() - startedAt,
        cpu_percent: result.cpu_percent,
        endpoint_latency_ms: endpointFinalization.latency_ms,
      });
    } catch (error) {
      if (!(error instanceof SttEvaluationBoundaryTimeoutError)) throw error;
      probeTrials.push({
        trial,
        outcome: "boundary_timeout",
        boundary_timeout_ms: boundaryTimeoutMs,
        elapsed_ms: performance.now() - startedAt,
        cpu_percent: cpuPercent(startedAt, initialCpuUsage),
      });
    }
  }

  const repeatedBoundaryTimeout = probeTrials.every(
    (trial) => trial.outcome === "boundary_timeout",
  );
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    experiment: "endpoint_timing",
    profile: "endpoint_only_1000",
    configuration: sttEvaluationProfileConfigurations.endpoint_only_1000,
    dataset: {
      manifest_sha256: datasetEvidence.manifest_sha256,
      case: caseEvidence,
    },
    trials: probeTrials,
    outcome: repeatedBoundaryTimeout ? "repeated_boundary_timeout" : "endpoint_observed",
    full_dataset_scoring_completed: false,
    observations_written: false,
    decision: repeatedBoundaryTimeout ? "not_adopted" : "full_dataset_evaluation_required",
    scope: repeatedBoundaryTimeout
      ? "The same required case was replayed three times with endpoint-only finalization. Full-dataset scoring stopped because every trial reached the outer boundary timeout. No transcript observations were written and no production runtime was changed."
      : "The required case produced a Soniox endpoint in at least one trial. This probe does not score the full dataset or change the production runtime.",
  };
}
