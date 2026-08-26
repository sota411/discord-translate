import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import opus from "@discordjs/opus";
import { SonioxNodeClient, type RealtimeResult } from "@soniox/node";

import { decodeDiscordOpusPacketToMono } from "../audio/pcm.js";
import { SonioxSttFactory } from "../soniox/control.js";
import { createSttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import type {
  LoadedSttEvaluationCase,
  LoadedSttEvaluationDataset,
} from "./stt-evaluation-files.js";
import {
  sttInsertionTriageConditionConfigurations,
  type SttInsertionTriageCondition,
  type SttInsertionTriageObservations,
} from "./stt-insertion-triage.js";

const { OpusEncoder } = opus;
const pcmSampleRate = 48_000;
const pcmBytesPerSample = 2;
const trailingSilenceMs = 200;
const maximumTrialCount = 10;
const defaultBoundaryTimeoutMs = 10_000;
const defaultFinishTimeoutMs = 10_000;
const validOpusFrameSampleCounts = [120, 240, 480, 960, 1_920, 2_880] as const;
const conditions = Object.keys(sttInsertionTriageConditionConfigurations) as
  SttInsertionTriageCondition[];

export type SttInsertionTriageRunnerOptions = {
  apiKey: string;
  model: string;
  sttWebSocketUrl: string;
  caseIds: readonly string[];
  trials?: number;
  boundaryTimeoutMs?: number;
  finishTimeoutMs?: number;
};

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

function isEvaluationLanguage(value: string | undefined): value is "ja" | "ko" {
  return value === "ja" || value === "ko";
}

function monoToStereo(mono: Buffer): Buffer {
  if (mono.length === 0 || mono.length % pcmBytesPerSample !== 0) {
    throw new Error("Opus往復へ渡すmono PCMは正の2バイト境界にしてください");
  }
  const stereo = Buffer.allocUnsafe(mono.length * 2);
  for (
    let sourceOffset = 0, targetOffset = 0;
    sourceOffset < mono.length;
    sourceOffset += 2, targetOffset += 4
  ) {
    const sample = mono.readInt16LE(sourceOffset);
    stereo.writeInt16LE(sample, targetOffset);
    stereo.writeInt16LE(sample, targetOffset + 2);
  }
  return stereo;
}

function roundTripDiscordOpus(
  codec: InstanceType<typeof OpusEncoder>,
  source: Buffer,
): { audio: Buffer; paddingSampleCount: number } {
  const sourceSampleCount = source.length / pcmBytesPerSample;
  const frameSampleCount = validOpusFrameSampleCounts.find(
    (candidate) => candidate >= sourceSampleCount,
  );
  if (!frameSampleCount) {
    throw new Error(
      `1 packetのPCM sample数${String(sourceSampleCount)}がOpusの60ms上限を超えています`,
    );
  }
  const padded = Buffer.alloc(frameSampleCount * pcmBytesPerSample);
  source.copy(padded);
  const encoded = codec.encode(monoToStereo(padded));
  const decoded = decodeDiscordOpusPacketToMono(codec, encoded);
  if (!decoded) throw new Error("評価用に生成したOpus packetを復号できませんでした");
  if (decoded.length !== padded.length) {
    throw new Error("Opus往復後のPCM sample数が送信frameと一致しません");
  }
  return {
    audio: decoded,
    paddingSampleCount: frameSampleCount - sourceSampleCount,
  };
}

async function runCase(
  client: SonioxNodeClient,
  dataset: LoadedSttEvaluationDataset,
  evaluationCase: LoadedSttEvaluationCase,
  trial: number,
  condition: SttInsertionTriageCondition,
  model: string,
  boundaryTimeoutMs: number,
  finishTimeoutMs: number,
): Promise<SttInsertionTriageObservations["results"][number]> {
  const configuration = sttInsertionTriageConditionConfigurations[condition];
  const factory = new SonioxSttFactory(client, model, false, {
    translationEnabled: configuration.translation_enabled,
    endpointDetectionEnabled: configuration.endpoint_detection_enabled,
  });
  const { session } = factory.create(
    dataset.manifest.pair,
    `stt-insertion-triage-${randomUUID()}`,
    [],
  );
  const finalized = Promise.withResolvers<undefined>();
  const recognizedLanguages = new Set<"ja" | "ko">();
  const originalFinalTokens: SttInsertionTriageObservations["results"][number][
    "original_final_tokens"
  ] = [];
  const finalTokenIdentities = new Set<string>();
  let transcript = "";
  let endpointEventCount = 0;
  let finalizedEventCount = 0;
  let finalizeCallCount = 0;
  let sendAudioCallCount = 0;
  let sentAudioBytes = 0;
  let sourcePacketSendCount = 0;
  let duplicateSourcePacketIndexCount = 0;
  let decodedSampleCount = 0;
  let codecPaddingSampleCount = 0;
  let opusPacketCount = 0;
  const sentSourcePacketIndexes = new Set<number>();
  const codec = configuration.input_route === "discord_opus_roundtrip"
    ? new OpusEncoder(pcmSampleRate, 2)
    : undefined;
  const trailingSilence = Buffer.alloc(
    Math.round(pcmSampleRate * pcmBytesPerSample * trailingSilenceMs / 1_000),
  );

  const sendAudio = (audio: Buffer): void => {
    sendAudioCallCount += 1;
    sentAudioBytes += audio.length;
    session.sendAudio(audio);
  };
  const handleResult = (result: RealtimeResult): void => {
    for (const token of result.tokens) {
      if (
        !token.is_final ||
        (token.translation_status !== "original" && token.translation_status !== "none")
      ) {
        continue;
      }
      if (token.start_ms !== undefined && token.end_ms !== undefined) {
        const identity = JSON.stringify([
          token.start_ms,
          token.end_ms,
          token.text,
          token.language ?? null,
        ]);
        if (finalTokenIdentities.has(identity)) {
          finalized.reject(new Error("同じ時刻のfinal原文tokenが重複しています"));
          return;
        }
        finalTokenIdentities.add(identity);
      }
      transcript += token.text;
      if (isEvaluationLanguage(token.language)) recognizedLanguages.add(token.language);
      originalFinalTokens.push({
        start_ms: token.start_ms ?? null,
        end_ms: token.end_ms ?? null,
        text: token.text,
        language: token.language ?? null,
        confidence: token.confidence,
      });
    }
  };
  session.on("result", handleResult);
  session.on("endpoint", () => {
    endpointEventCount += 1;
  });
  session.on("finalized", () => {
    finalizedEventCount += 1;
    finalized.resolve(undefined);
  });
  session.on("error", finalized.reject);

  let finished = false;
  try {
    await session.connect();
    const replayStartedAt = performance.now();
    for (const [packetIndex, packet] of evaluationCase.packets.entries()) {
      await waitUntil(replayStartedAt, packet.atMs);
      if (sentSourcePacketIndexes.has(packetIndex)) duplicateSourcePacketIndexCount += 1;
      sentSourcePacketIndexes.add(packetIndex);
      sourcePacketSendCount += 1;
      let outgoing = packet.audio;
      if (codec) {
        const roundTrip = roundTripDiscordOpus(codec, packet.audio);
        outgoing = roundTrip.audio;
        codecPaddingSampleCount += roundTrip.paddingSampleCount;
        opusPacketCount += 1;
      }
      decodedSampleCount += outgoing.length / pcmBytesPerSample;
      sendAudio(outgoing);
    }
    sendAudio(trailingSilence);
    finalizeCallCount += 1;
    session.finalize({ trailing_silence_ms: trailingSilenceMs });

    await withTimeout(
      finalized.promise,
      boundaryTimeoutMs,
      `trial「${String(trial)}」case「${evaluationCase.definition.id}」condition「${condition}」のfinalizedがtimeoutしました`,
    );
    await withTimeout(
      session.finish(),
      finishTimeoutMs,
      `trial「${String(trial)}」case「${evaluationCase.definition.id}」condition「${condition}」の終了応答がtimeoutしました`,
    );
    finished = true;
    if (finalizeCallCount !== 1) {
      throw new Error("既知終端のfinalize回数が1回ではありません");
    }
    const sourceSampleCount = evaluationCase.packets.reduce(
      (sum, packet) => sum + packet.audio.length / pcmBytesPerSample,
      0,
    );
    return {
      trial,
      case_id: evaluationCase.definition.id,
      condition,
      transcript,
      recognized_languages: [...recognizedLanguages],
      original_final_tokens: originalFinalTokens,
      input_audit: {
        source_audio_sha256: evaluationCase.audioSha256,
        source_sample_count: sourceSampleCount,
        source_duration_ms: sourceSampleCount / pcmSampleRate * 1_000,
        source_packet_count: evaluationCase.packets.length,
        source_packet_send_count: sourcePacketSendCount,
        duplicate_source_packet_index_count: duplicateSourcePacketIndexCount,
        missing_source_packet_count: evaluationCase.packets.length -
          sentSourcePacketIndexes.size,
        opus_packet_count: codec ? opusPacketCount : null,
        decoded_sample_count: decodedSampleCount,
        codec_padding_sample_count: codecPaddingSampleCount,
        send_audio_call_count: sendAudioCallCount,
        sent_audio_bytes: sentAudioBytes,
        sent_audio_duration_ms: sentAudioBytes /
          (pcmSampleRate * pcmBytesPerSample) * 1_000,
        injected_silence_ms: trailingSilenceMs,
        finalize_call_count: finalizeCallCount,
        endpoint_event_count: endpointEventCount,
        finalized_event_count: finalizedEventCount,
      },
      configuration,
    };
  } finally {
    if (!finished) session.close();
  }
}

export async function runSttInsertionTriageDataset(
  dataset: LoadedSttEvaluationDataset,
  options: SttInsertionTriageRunnerOptions,
): Promise<SttInsertionTriageObservations> {
  if (options.apiKey.trim().length === 0) throw new Error("Soniox API keyが空です");
  if (options.model.trim().length === 0) throw new Error("Soniox STT modelが空です");
  if (options.sttWebSocketUrl.trim().length === 0) {
    throw new Error("Soniox STT WebSocket URLが空です");
  }
  if (options.caseIds.length === 0 || new Set(options.caseIds).size !== options.caseIds.length) {
    throw new Error("大量挿入triageのcase IDは重複なしで1件以上指定してください");
  }
  const casesById = new Map(dataset.cases.map((evaluationCase) => [
    evaluationCase.definition.id,
    evaluationCase,
  ]));
  const selectedCases = options.caseIds.map((caseId) => {
    const evaluationCase = casesById.get(caseId);
    if (!evaluationCase) throw new Error(`大量挿入triageのcase「${caseId}」がありません`);
    return evaluationCase;
  });
  const trials = options.trials ?? 5;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > maximumTrialCount) {
    throw new Error(`大量挿入triageのtrial数は1〜${String(maximumTrialCount)}にしてください`);
  }
  const boundaryTimeoutMs = options.boundaryTimeoutMs ?? defaultBoundaryTimeoutMs;
  const finishTimeoutMs = options.finishTimeoutMs ?? defaultFinishTimeoutMs;
  if (
    !Number.isSafeInteger(boundaryTimeoutMs) || boundaryTimeoutMs <= 0 ||
    !Number.isSafeInteger(finishTimeoutMs) || finishTimeoutMs <= 0
  ) {
    throw new Error("大量挿入triageのtimeoutは正の整数にしてください");
  }
  const client = new SonioxNodeClient({
    api_key: options.apiKey,
    realtime: { ws_base_url: options.sttWebSocketUrl },
  });
  const results: SttInsertionTriageObservations["results"] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const [caseIndex, evaluationCase] of selectedCases.entries()) {
      const startIndex = (trial - 1 + caseIndex) % conditions.length;
      for (let offset = 0; offset < conditions.length; offset += 1) {
        const condition = conditions[(startIndex + offset) % conditions.length];
        if (!condition) throw new Error("大量挿入triageの条件順を解決できませんでした");
        results.push(await runCase(
          client,
          dataset,
          evaluationCase,
          trial,
          condition,
          options.model,
          boundaryTimeoutMs,
          finishTimeoutMs,
        ));
      }
    }
  }
  return {
    version: 1,
    experiment: "insertion_triage",
    selected_case_ids: [...options.caseIds],
    dataset: createSttEvaluationDatasetEvidence(dataset),
    results,
  };
}
