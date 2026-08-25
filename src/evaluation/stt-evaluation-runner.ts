import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  SonioxNodeClient,
  type RealtimeResult,
} from "@soniox/node";

import {
  SttTurnFinalizer,
  type SttBoundaryKind,
} from "../audio/stt-turn-finalizer.js";
import { SonioxSttFactory } from "../soniox/control.js";
import { createSttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import type {
  LoadedSttEvaluationCase,
  LoadedSttEvaluationDataset,
} from "./stt-evaluation-files.js";
import type {
  SttEvaluationConfiguration,
  SttEvaluationObservations,
  SttEvaluationProfile,
} from "./stt-evaluation.js";

const discordSpeakingEndDelayMs = 100;
const sonioxDefaultMaxEndpointDelayMs = 2_000;
const transcriptInactivityMs = 3_000;
const maxTurnMs = 30_000;
const trailingSilenceMs = 200;

const profileConfigurations = {
  baseline: {
    recognition_context_enabled: false,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: discordSpeakingEndDelayMs,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: sonioxDefaultMaxEndpointDelayMs,
    preprocessing: "none",
  },
  context: {
    recognition_context_enabled: true,
    endpoint_mode: "manual_early",
    discord_speaking_end_delay_ms: discordSpeakingEndDelayMs,
    manual_finalize_fallback_ms: 100,
    soniox_max_endpoint_delay_ms: sonioxDefaultMaxEndpointDelayMs,
    preprocessing: "none",
  },
  endpoint: {
    recognition_context_enabled: false,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: discordSpeakingEndDelayMs,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
    preprocessing: "none",
  },
  context_endpoint: {
    recognition_context_enabled: true,
    endpoint_mode: "soniox_primary",
    discord_speaking_end_delay_ms: discordSpeakingEndDelayMs,
    manual_finalize_fallback_ms: 600,
    soniox_max_endpoint_delay_ms: 500,
    preprocessing: "none",
  },
} as const satisfies Readonly<Record<SttEvaluationProfile, SttEvaluationConfiguration>>;

type SttEvaluationRunResult = SttEvaluationObservations["results"][number] & {
  configuration: SttEvaluationConfiguration;
};

export type SttEvaluationRunObservations = Omit<SttEvaluationObservations, "dataset" | "results"> & {
  dataset: NonNullable<SttEvaluationObservations["dataset"]>;
  results: SttEvaluationRunResult[];
};

export type SttEvaluationRunnerOptions = {
  apiKey: string;
  model: string;
  sttWebSocketUrl: string;
  profiles?: readonly SttEvaluationProfile[];
  boundaryTimeoutMs?: number;
  finishTimeoutMs?: number;
};

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
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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
  profile: SttEvaluationProfile,
  model: string,
  boundaryTimeoutMs: number,
  finishTimeoutMs: number,
): Promise<SttEvaluationRunResult> {
  const configuration = profileConfigurations[profile];
  const contextFactory = new SonioxSttFactory(
    client,
    model,
    configuration.recognition_context_enabled,
    configuration.endpoint_mode === "soniox_primary"
      ? { maxEndpointDelayMs: configuration.soniox_max_endpoint_delay_ms }
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
  const finalizationLatenciesMs: number[] = [];
  let pendingText = "";
  let lastAudioAt: number | undefined;
  let lastPacketSent = false;
  let speakingEndTimer: NodeJS.Timeout | undefined;
  const finalizer = new SttTurnFinalizer({
    session,
    speakingEndDelayMs: configuration.manual_finalize_fallback_ms,
    transcriptInactivityMs,
    maxTurnMs,
    trailingSilenceMs,
    onError: boundary.reject,
  });

  const handleResult = (result: RealtimeResult): void => {
    if (result.tokens.length > 0) finalizer.transcriptProgressed();
    for (const token of result.tokens) {
      if (!token.is_final || token.translation_status !== "original") continue;
      pendingText += token.text;
      if (isEvaluationLanguage(token.language)) recognizedLanguages.add(token.language);
    }
  };
  const handleBoundary = (kind: SttBoundaryKind): void => {
    if (!finalizer.boundaryReceived(kind)) return;
    const hasText = pendingText.trim().length > 0;
    if (hasText) {
      segments.push(pendingText);
      pendingText = "";
    }
    if ((hasText || lastPacketSent) && lastAudioAt !== undefined) {
      finalizationLatenciesMs.push(Math.max(0, performance.now() - lastAudioAt));
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
      finalizer.speakingStarted();
      lastAudioAt = performance.now();
      lastPacketSent = index === evaluationCase.packets.length - 1;
      session.sendAudio(packet.audio);
      finalizer.audioReceived();
      speakingEndTimer = setTimeout(() => {
        speakingEndTimer = undefined;
        finalizer.speakingEnded();
      }, discordSpeakingEndDelayMs);
    }

    await withTimeout(
      boundary.promise,
      boundaryTimeoutMs,
      `case「${evaluationCase.definition.id}」profile「${profile}」の発話確定がtimeoutしました`,
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
      `case「${evaluationCase.definition.id}」profile「${profile}」の終了応答がtimeoutしました`,
    );
    finished = true;
    if (pendingText.trim().length > 0) segments.push(pendingText);
    if (finalizationLatenciesMs.length === 0) {
      throw new Error(
        `case「${evaluationCase.definition.id}」profile「${profile}」の確定遅延を取得できませんでした`,
      );
    }
    return {
      case_id: evaluationCase.definition.id,
      profile,
      transcript: segments.join(""),
      segments,
      recognized_languages: [...recognizedLanguages],
      finalization_latencies_ms: finalizationLatenciesMs,
      cpu_percent: measuredCpuPercent,
      decoded_packet_count: evaluationCase.packets.length,
      dropped_packet_count: evaluationCase.droppedPacketCount,
      configuration,
    };
  } finally {
    if (speakingEndTimer) clearTimeout(speakingEndTimer);
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
  const profiles = options.profiles ?? [
    "baseline",
    "context",
    "endpoint",
    "context_endpoint",
  ];
  if (profiles.length === 0 || new Set(profiles).size !== profiles.length) {
    throw new Error("STT評価profileは重複なしで1件以上指定してください");
  }
  const boundaryTimeoutMs = options.boundaryTimeoutMs ?? 10_000;
  const finishTimeoutMs = options.finishTimeoutMs ?? 10_000;
  if (boundaryTimeoutMs <= 0 || finishTimeoutMs <= 0) {
    throw new Error("STT評価timeoutは正の値にしてください");
  }
  const client = new SonioxNodeClient({
    api_key: options.apiKey,
    realtime: { ws_base_url: options.sttWebSocketUrl },
  });
  const results: SttEvaluationRunResult[] = [];
  for (const profile of profiles) {
    for (const evaluationCase of dataset.cases) {
      results.push(await runCase(
        client,
        dataset,
        evaluationCase,
        profile,
        options.model,
        boundaryTimeoutMs,
        finishTimeoutMs,
      ));
    }
  }
  return {
    version: 1,
    dataset: createSttEvaluationDatasetEvidence(dataset),
    results,
  };
}
