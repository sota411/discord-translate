import { setTimeout as delay } from "node:timers/promises";

import {
  StartStreamTranscriptionCommand,
  type StartStreamTranscriptionCommandOutput,
  type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";

import type { LoadedSttEvaluationCase } from "./stt-evaluation-files.js";
import {
  sttEvaluationProfileConfigurations,
  type SttEvaluationObservations,
} from "./stt-evaluation.js";

const maximumAudioChunkBytes = 48_000 * 2;

export type AmazonTranscribeStreamingSender = {
  send(
    command: StartStreamTranscriptionCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Pick<StartStreamTranscriptionCommandOutput, "TranscriptResultStream">>;
};

export type AmazonTranscribeEvaluationOptions = {
  client: AmazonTranscribeStreamingSender;
  timeoutMs?: number;
};

export type AmazonTranscribeEvaluationResult =
  SttEvaluationObservations["results"][number];

function cpuPercent(startedAt: number, initialUsage: NodeJS.CpuUsage): number {
  const elapsedMicroseconds = Math.max((performance.now() - startedAt) * 1_000, 1);
  const usage = process.cpuUsage(initialUsage);
  return (usage.user + usage.system) / elapsedMicroseconds * 100;
}

async function waitUntil(
  startedAt: number,
  targetOffsetMs: number,
  signal: AbortSignal,
): Promise<void> {
  const remainingMs = targetOffsetMs - (performance.now() - startedAt);
  if (remainingMs > 0) await delay(remainingMs, undefined, { signal });
}

function evaluationLanguage(language: string | undefined): "ja" | "ko" | undefined {
  if (language === "ja-JP") return "ja";
  if (language === "ko-KR") return "ko";
  return undefined;
}

function streamError(event: TranscriptResultStream): Error | undefined {
  const candidates = [
    ["BadRequestException", event.BadRequestException],
    ["LimitExceededException", event.LimitExceededException],
    ["InternalFailureException", event.InternalFailureException],
    ["ConflictException", event.ConflictException],
    ["ServiceUnavailableException", event.ServiceUnavailableException],
  ] as const;
  for (const [name, value] of candidates) {
    if (value) return new Error(`Amazon Transcribe ${name}: ${value.Message ?? "詳細なし"}`);
  }
  if (event.$unknown) {
    return new Error(`Amazon Transcribeから未知のstream event「${event.$unknown[0]}」を受信しました`);
  }
  return undefined;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  cleanup: () => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutError = new Error(
    `Amazon Transcribe評価が${String(timeoutMs)}msでtimeoutしました`,
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      void cleanup().then(
        () => reject(timeoutError),
        () => reject(timeoutError),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Amazon Transcribe評価が中断されました");
}

async function nextResultStreamEvent(
  iterator: AsyncIterator<TranscriptResultStream>,
  signal: AbortSignal,
): Promise<IteratorResult<TranscriptResultStream>> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<IteratorResult<TranscriptResultStream>>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    let next: Promise<IteratorResult<TranscriptResultStream>>;
    try {
      next = iterator.next();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error
        ? error
        : new Error("Amazon Transcribeの結果iteratorを読み出せませんでした"));
      return;
    }
    void next.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export async function runAmazonTranscribeEvaluationCase(
  evaluationCase: LoadedSttEvaluationCase,
  trial: number,
  options: AmazonTranscribeEvaluationOptions,
): Promise<AmazonTranscribeEvaluationResult> {
  if (!Number.isSafeInteger(trial) || trial <= 0) {
    throw new Error("Amazon Transcribe評価trialは正の整数にしてください");
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Amazon Transcribe評価timeoutは正の整数にしてください");
  }
  if (evaluationCase.packets.some((packet) => packet.audio.length > maximumAudioChunkBytes)) {
    throw new Error("Amazon Transcribeへ送るPCM chunkは1秒以下にしてください");
  }

  let timeoutCleanup = async (): Promise<void> => await Promise.resolve();
  return await withTimeout(async (signal) => {
    const startedAt = performance.now();
    const initialCpuUsage = process.cpuUsage();
    let lastAudioAt: number | undefined;
    let lastFinalResultAt: number | undefined;

    const audioStream = async function* () {
      const replayStartedAt = performance.now();
      for (const packet of evaluationCase.packets) {
        await waitUntil(replayStartedAt, packet.atMs, signal);
        lastAudioAt = performance.now();
        yield { AudioEvent: { AudioChunk: packet.audio } };
      }
    };

    const command = new StartStreamTranscriptionCommand({
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 48_000,
      IdentifyMultipleLanguages: true,
      LanguageOptions: "ja-JP,ko-KR",
      EnablePartialResultsStabilization: false,
      AudioStream: audioStream(),
    });
    const response = await options.client.send(command, { abortSignal: signal });
    if (!response.TranscriptResultStream) {
      throw new Error("Amazon Transcribeの結果streamがありません");
    }

    const resultIterator = response.TranscriptResultStream[Symbol.asyncIterator]();
    let resultStreamCompleted = false;
    let closeResultStreamPromise: Promise<void> | undefined;
    const closeResultStream = async (): Promise<void> => {
      if (resultStreamCompleted) return;
      closeResultStreamPromise ??= (async () => {
        await resultIterator.return?.();
      })();
      await closeResultStreamPromise;
    };
    timeoutCleanup = closeResultStream;

    const segments: string[] = [];
    const recognizedLanguages = new Set<"ja" | "ko">();
    const originalConfidences: number[] = [];
    try {
      let next = await nextResultStreamEvent(resultIterator, signal);
      while (!next.done) {
        const event = next.value;
        const error = streamError(event);
        if (error) throw error;
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          if (result.IsPartial !== false) continue;
          const transcript = result.Alternatives?.[0]?.Transcript?.trim();
          if (transcript) segments.push(transcript);
          const language = evaluationLanguage(result.LanguageCode);
          if (language) recognizedLanguages.add(language);
          for (const item of result.Alternatives?.[0]?.Items ?? []) {
            if (item.Confidence !== undefined) originalConfidences.push(item.Confidence);
          }
          lastFinalResultAt = performance.now();
        }
        next = await nextResultStreamEvent(resultIterator, signal);
      }
      resultStreamCompleted = true;
    } finally {
      await closeResultStream();
    }
    const completedAt = performance.now();
    if (lastAudioAt === undefined) {
      throw new Error("Amazon TranscribeへPCMを送信できませんでした");
    }
    const confidenceMean = originalConfidences.length === 0
      ? null
      : originalConfidences.reduce((sum, value) => sum + value, 0) /
        originalConfidences.length;
    const transcript = segments.join("");
    return {
      trial,
      case_id: evaluationCase.definition.id,
      profile: "amazon_transcribe",
      transcript,
      segments,
      recognized_languages: [...recognizedLanguages],
      finalizations: [{
        kind: "finalized",
        reason: "provider_final",
        latency_ms: Math.max(0, (lastFinalResultAt ?? completedAt) - lastAudioAt),
        has_text: transcript.length > 0,
      }],
      cpu_percent: cpuPercent(startedAt, initialCpuUsage),
      decoded_packet_count: evaluationCase.packets.length,
      dropped_packet_count: evaluationCase.droppedPacketCount,
      audio_metrics: {
        ...evaluationCase.pcmMetrics,
        original_token_count: originalConfidences.length,
        original_confidence_mean: confidenceMean,
        original_confidence_min: originalConfidences.length === 0
          ? null
          : Math.min(...originalConfidences),
      },
      configuration: sttEvaluationProfileConfigurations.amazon_transcribe,
    };
  }, timeoutMs, async () => await timeoutCleanup());
}
