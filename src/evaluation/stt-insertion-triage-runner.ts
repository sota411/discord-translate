import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { SonioxNodeClient, type RealtimeResult } from "@soniox/node";

import {
  SttTurnFinalizer,
  type SttAcceptedFinalizeReason,
  type SttBoundaryKind,
} from "../audio/stt-turn-finalizer.js";
import { SonioxSttFactory } from "../soniox/control.js";
import {
  loadVerifiedSttInsertionAudioAudit,
  type VerifiedSttInsertionAudioAudit,
} from "./stt-insertion-audio-audit.js";
import {
  sha256,
  SttInsertionDiscordOpusRoundTrip,
  sttInsertionPcmBytesPerSample,
  sttInsertionPcmSampleRate,
} from "./stt-insertion-audio.js";
import { createSttEvaluationDatasetEvidence } from "./stt-evaluation-files.js";
import type {
  LoadedSttEvaluationCase,
  LoadedSttEvaluationDataset,
} from "./stt-evaluation-files.js";
import {
  createSttInsertionTriageRunOrder,
  parseSttInsertionTriageObservations,
  sttInsertionTriageConditionConfigurations,
  type SttInsertionTriageCondition,
  type SttInsertionTriageObservations,
} from "./stt-insertion-triage.js";
import { scoreSttCharacterError } from "./stt-evaluation.js";
import { assertPrivateSttEvaluationDatasetPaths } from "./stt-private-files.js";

const trailingSilenceMs = 200;
const transcriptInactivityMs = 3_000;
const maxTurnMs = 30_000;
const maximumTrialCount = 10;
const defaultBoundaryTimeoutMs = 10_000;
const defaultFinishTimeoutMs = 10_000;

type TriageResult = SttInsertionTriageObservations["results"][number];
type AcceptedBoundary = TriageResult["accepted_boundaries"][number];
type VerifiedAuditCase = VerifiedSttInsertionAudioAudit["cases"][number];

export type SttInsertionTriageRunnerOptions = {
  apiKey: string;
  model: string;
  sttWebSocketUrl: string;
  caseIds: readonly string[];
  audioAuditPath: string;
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

function acceptedReason(
  reason: SttAcceptedFinalizeReason,
): AcceptedBoundary["reason"] {
  return reason;
}

async function runCase(
  client: SonioxNodeClient,
  dataset: LoadedSttEvaluationDataset,
  evaluationCase: LoadedSttEvaluationCase,
  auditCase: VerifiedAuditCase,
  executionIndex: number,
  trial: number,
  condition: SttInsertionTriageCondition,
  model: string,
  boundaryTimeoutMs: number,
  finishTimeoutMs: number,
): Promise<TriageResult> {
  const configuration = sttInsertionTriageConditionConfigurations[condition];
  const historical = configuration.finalization_mode === "historical_baseline";
  const factory = new SonioxSttFactory(client, model, false, {
    translationEnabled: configuration.translation_enabled,
    endpointDetectionEnabled: configuration.endpoint_detection_enabled,
  });
  const { session } = factory.create(
    dataset.manifest.pair,
    `stt-insertion-triage-${randomUUID()}`,
    configuration.translation_terms_enabled
      ? evaluationCase.definition.translation_terms
      : [],
  );
  const terminalBoundary = Promise.withResolvers<AcceptedBoundary>();
  const recognizedLanguages = new Set<"ja" | "ko">();
  const originalFinalTokens: TriageResult["original_final_tokens"] = [];
  const finalTokenIdentities = new Set<string>();
  const acceptedBoundaries: AcceptedBoundary[] = [];
  let duplicateFinalOriginalTokenCount = 0;
  let transcript = "";
  let endpointEventCount = 0;
  let finalizedEventCount = 0;
  let finalizeCallCount = 0;
  let sendAudioCallCount = 0;
  let sentAudioBytes = 0;
  let trailingSilenceSampleCount = 0;
  let sourcePacketSendCount = 0;
  let duplicateSourcePacketIndexCount = 0;
  let decodedSampleCount = 0;
  let codecPaddingSampleCount = 0;
  let opusPacketCount = 0;
  let lastSourcePacketSent = false;
  let replayStartedAt: number | undefined;
  let speakingEndTimer: NodeJS.Timeout | undefined;
  let terminalBoundaryAccepted = false;
  const sentSourcePacketIndexes = new Set<number>();
  const sentSpeechChunks: Buffer[] = [];
  const codec = configuration.input_route === "discord_opus_roundtrip"
    ? new SttInsertionDiscordOpusRoundTrip()
    : undefined;
  const trailingSilence = Buffer.alloc(
    Math.round(
      sttInsertionPcmSampleRate * sttInsertionPcmBytesPerSample *
      trailingSilenceMs / 1_000,
    ),
  );

  const sendAudio = (audio: Buffer): void => {
    sendAudioCallCount += 1;
    sentAudioBytes += audio.length;
    session.sendAudio(audio);
  };
  const sendSpeechAudio = (audio: Buffer): void => {
    sentSpeechChunks.push(audio);
    sendAudio(audio);
  };
  const sendTrailingSilence = (audio: Buffer): void => {
    trailingSilenceSampleCount += audio.length / sttInsertionPcmBytesPerSample;
    sendAudio(audio);
  };
  const finalize = (options?: { trailing_silence_ms?: number }): void => {
    finalizeCallCount += 1;
    if (!historical && finalizeCallCount > 1) {
      terminalBoundary.reject(new Error("finalize()が複数回呼ばれました"));
      return;
    }
    session.finalize(options);
  };
  const finalizer = new SttTurnFinalizer({
    session: {
      sendAudio: sendTrailingSilence,
      finalize,
    },
    speakingEndDelayMs: configuration.manual_finalize_fallback_ms ?? 0,
    transcriptInactivityMs,
    maxTurnMs,
    trailingSilenceMs,
    onError: terminalBoundary.reject,
  });

  const boundaryReceivedAt = (): number => {
    if (replayStartedAt === undefined) {
      throw new Error("音声replay開始前にSTT境界を受信しました");
    }
    return Math.max(0, performance.now() - replayStartedAt);
  };
  const acceptHistoricalBoundary = (kind: SttBoundaryKind): void => {
    if (!finalizer.boundaryReceived(kind)) return;
    const reason = finalizer.takeAcceptedFinalizeReason();
    if (!reason) {
      terminalBoundary.reject(new Error("historical baselineの確定理由を取得できませんでした"));
      return;
    }
    const accepted: AcceptedBoundary = {
      kind,
      reason: acceptedReason(reason),
      received_at_ms: boundaryReceivedAt(),
    };
    acceptedBoundaries.push(accepted);
    if (!lastSourcePacketSent || terminalBoundaryAccepted) return;
    terminalBoundaryAccepted = true;
    terminalBoundary.resolve(accepted);
  };

  const handleResult = (result: RealtimeResult): void => {
    if (historical && result.tokens.length > 0) finalizer.transcriptProgressed();
    const receivedAtMs = replayStartedAt === undefined
      ? undefined
      : Math.max(0, performance.now() - replayStartedAt);
    if (receivedAtMs === undefined && result.tokens.length > 0) {
      terminalBoundary.reject(new Error("音声replay開始前にSTT tokenを受信しました"));
      return;
    }
    for (const token of result.tokens) {
      const isOriginal = historical
        ? token.translation_status === "original"
        : token.translation_status === "original" || token.translation_status === "none";
      if (!token.is_final || !isOriginal) continue;
      if (token.start_ms !== undefined && token.end_ms !== undefined) {
        const identity = JSON.stringify([
          token.start_ms,
          token.end_ms,
          token.text,
          token.language ?? null,
        ]);
        if (finalTokenIdentities.has(identity)) {
          duplicateFinalOriginalTokenCount += 1;
          if (!historical) {
            terminalBoundary.reject(new Error("同じ時刻のfinal原文tokenが重複しています"));
            return;
          }
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
        received_at_ms: receivedAtMs ?? 0,
      });
    }
  };
  session.on("result", handleResult);
  session.on("endpoint", () => {
    endpointEventCount += 1;
    if (historical) acceptHistoricalBoundary("endpoint");
  });
  session.on("finalized", () => {
    finalizedEventCount += 1;
    if (historical) {
      acceptHistoricalBoundary("finalized");
      return;
    }
    if (terminalBoundaryAccepted) return;
    const accepted: AcceptedBoundary = {
      kind: "finalized",
      reason: "known_file_end",
      received_at_ms: boundaryReceivedAt(),
    };
    acceptedBoundaries.push(accepted);
    terminalBoundaryAccepted = true;
    terminalBoundary.resolve(accepted);
  });
  session.on("error", terminalBoundary.reject);

  let finished = false;
  try {
    await session.connect();
    replayStartedAt = performance.now();
    for (const [packetIndex, packet] of evaluationCase.packets.entries()) {
      await waitUntil(replayStartedAt, packet.atMs);
      if (sentSourcePacketIndexes.has(packetIndex)) duplicateSourcePacketIndexCount += 1;
      sentSourcePacketIndexes.add(packetIndex);
      sourcePacketSendCount += 1;
      if (historical) {
        if (speakingEndTimer) clearTimeout(speakingEndTimer);
        finalizer.speakingStarted();
      }
      let outgoing = packet.audio;
      if (codec) {
        const roundTrip = codec.process(packet.audio);
        outgoing = roundTrip.audio;
        codecPaddingSampleCount += roundTrip.paddingSampleCount;
        opusPacketCount += 1;
      }
      decodedSampleCount += outgoing.length / sttInsertionPcmBytesPerSample;
      lastSourcePacketSent = packetIndex === evaluationCase.packets.length - 1;
      sendSpeechAudio(outgoing);
      if (historical) {
        finalizer.audioReceived();
        const speakingEndDelayMs = configuration.discord_speaking_end_delay_ms;
        speakingEndTimer = setTimeout(() => {
          speakingEndTimer = undefined;
          finalizer.speakingEnded();
        }, speakingEndDelayMs);
      }
    }
    if (!historical) {
      sendTrailingSilence(trailingSilence);
      finalize({ trailing_silence_ms: trailingSilenceMs });
    }

    await withTimeout(
      terminalBoundary.promise,
      boundaryTimeoutMs,
      `trial「${String(trial)}」case「${evaluationCase.definition.id}」condition「${condition}」のSTT境界がtimeoutしました`,
    );
    if (speakingEndTimer) {
      clearTimeout(speakingEndTimer);
      speakingEndTimer = undefined;
    }
    finalizer.close();
    await withTimeout(
      session.finish(),
      finishTimeoutMs,
      `trial「${String(trial)}」case「${evaluationCase.definition.id}」condition「${condition}」の終了応答がtimeoutしました`,
    );
    finished = true;
    if (!historical && finalizeCallCount !== 1) {
      throw new Error("既知終端のfinalize回数が1回ではありません");
    }
    const sourceSampleCount = evaluationCase.packets.reduce(
      (sum, packet) => sum + packet.audio.length / sttInsertionPcmBytesPerSample,
      0,
    );
    const sentSpeech = Buffer.concat(sentSpeechChunks);
    const sentSpeechSampleCount = sentSpeech.length / sttInsertionPcmBytesPerSample;
    const sentSpeechDurationMs = sentSpeechSampleCount / sttInsertionPcmSampleRate * 1_000;
    const characterError = scoreSttCharacterError(auditCase.heard_reference, transcript);
    return {
      execution_index: executionIndex,
      trial,
      case_id: evaluationCase.definition.id,
      condition,
      reference_text: auditCase.heard_reference,
      transcript,
      recognized_languages: [...recognizedLanguages],
      original_final_tokens: originalFinalTokens,
      duplicate_final_original_token_count: duplicateFinalOriginalTokenCount,
      accepted_boundaries: acceptedBoundaries,
      character_error: characterError,
      transcript_characters_per_second: characterError.hypothesis_characters /
        (sentSpeechDurationMs / 1_000),
      input_audit: {
        source_audio_sha256: evaluationCase.audioSha256,
        source_sample_count: sourceSampleCount,
        source_duration_ms: sourceSampleCount / sttInsertionPcmSampleRate * 1_000,
        source_packet_count: evaluationCase.packets.length,
        source_packet_send_count: sourcePacketSendCount,
        duplicate_source_packet_index_count: duplicateSourcePacketIndexCount,
        missing_source_packet_count: evaluationCase.packets.length -
          sentSourcePacketIndexes.size,
        sent_speech_audio_sha256: sha256(sentSpeech),
        sent_speech_sample_count: sentSpeechSampleCount,
        sent_speech_duration_ms: sentSpeechDurationMs,
        opus_packet_count: codec ? opusPacketCount : null,
        decoded_sample_count: decodedSampleCount,
        codec_padding_sample_count: codecPaddingSampleCount,
        send_audio_call_count: sendAudioCallCount,
        sent_audio_bytes: sentAudioBytes,
        sent_audio_duration_ms: sentAudioBytes /
          (sttInsertionPcmSampleRate * sttInsertionPcmBytesPerSample) * 1_000,
        trailing_silence_ms: trailingSilenceSampleCount /
          sttInsertionPcmSampleRate * 1_000,
        finalize_call_count: finalizeCallCount,
        endpoint_event_count: endpointEventCount,
        finalized_event_count: finalizedEventCount,
      },
      configuration,
    };
  } finally {
    if (speakingEndTimer) clearTimeout(speakingEndTimer);
    finalizer.close();
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
  await assertPrivateSttEvaluationDatasetPaths(dataset);
  const audioAudit = await loadVerifiedSttInsertionAudioAudit(
    dataset,
    options.audioAuditPath,
    options.caseIds,
  );
  const casesById = new Map(dataset.cases.map((evaluationCase) => [
    evaluationCase.definition.id,
    evaluationCase,
  ]));
  const auditById = new Map(audioAudit.cases.map((auditCase) => [
    auditCase.case_id,
    auditCase,
  ]));
  for (const caseId of options.caseIds) {
    if (!casesById.has(caseId)) throw new Error(`大量挿入triageのcase「${caseId}」がありません`);
    if (!auditById.has(caseId)) {
      throw new Error(`大量挿入triageのcase「${caseId}」にverified音声監査がありません`);
    }
  }
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
  const results: TriageResult[] = [];
  const order = createSttInsertionTriageRunOrder(options.caseIds, trials);
  for (const [orderIndex, entry] of order.entries()) {
    const evaluationCase = casesById.get(entry.case_id);
    const auditCase = auditById.get(entry.case_id);
    if (!evaluationCase || !auditCase) {
      throw new Error(`大量挿入triageのcase「${entry.case_id}」を解決できませんでした`);
    }
    results.push(await runCase(
      client,
      dataset,
      evaluationCase,
      auditCase,
      orderIndex + 1,
      entry.trial,
      entry.condition,
      options.model,
      boundaryTimeoutMs,
      finishTimeoutMs,
    ));
  }
  const selectedAuditCases = options.caseIds.map((caseId) => {
    const auditCase = auditById.get(caseId);
    if (!auditCase) throw new Error(`verified音声監査のcase「${caseId}」がありません`);
    return {
      case_id: caseId,
      reference_status: "verified" as const,
      intended_reference_sha256: sha256(Buffer.from(auditCase.intended_reference, "utf8")),
      heard_reference_sha256: sha256(Buffer.from(auditCase.heard_reference, "utf8")),
      source_audio_sha256: auditCase.source_audio_sha256,
      source_wav_sha256: auditCase.source_wav_sha256,
      opus_roundtrip_audio_sha256: auditCase.opus_roundtrip_audio_sha256,
      opus_roundtrip_wav_sha256: auditCase.opus_roundtrip_wav_sha256,
    };
  });
  return parseSttInsertionTriageObservations(JSON.stringify({
    version: 2,
    experiment: "insertion_triage",
    selected_case_ids: [...options.caseIds],
    dataset: createSttEvaluationDatasetEvidence(dataset),
    audio_audit: {
      audit_sha256: audioAudit.audit_sha256,
      manifest_sha256: audioAudit.manifest_sha256,
      cases: selectedAuditCases,
    },
    results,
  }));
}
