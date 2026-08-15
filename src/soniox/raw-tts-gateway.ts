import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import WebSocket, { type RawData } from "ws";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type {
  SynthesizedSpeech,
  TtsGateway,
} from "../translation/utterance-processor.js";

export type TtsUsageLedger = {
  openProviderRequest(input: {
    requestRef: string;
    sessionId: string;
    userId: string;
    kind: "tts";
    startedAt: Date;
  }): void;
  recordProviderUsage(input: {
    requestRef: string;
    audioMs: number;
    textCharacterCount: number;
    at: Date;
  }): void;
  finishProviderRequest(
    requestRef: string,
    status: "completed" | "failed",
    endedAt: Date,
  ): void;
};

type RawSonioxTtsGatewayOptions = {
  url: string;
  apiKey: string;
  model: string;
  voices: Readonly<Record<Language, string>>;
  terminationTimeoutMs: number;
  ledger: TtsUsageLedger;
  connectTimeoutMs?: number;
  createRequestRef?: () => string;
  now?: () => Date;
};

type TtsWireEvent = {
  stream_id?: string;
  audio?: string;
  audio_end?: boolean;
  terminated?: boolean;
  error_code?: number;
  error_type?: string;
};

function mapTtsError(event: TtsWireEvent): ApplicationError {
  if (
    event.error_code === 413 &&
    event.error_type === "max_audio_duration_reached"
  ) {
    return new ApplicationError(
      "TTS_OUTPUT_LIMIT_REACHED",
      "生成音声がSonioxの長さ上限へ達しました。発話を短く区切ってください。",
    );
  }
  if (event.error_code === 401 || event.error_code === 403) {
    return new ApplicationError(
      "SONIOX_AUTH_FAILED",
      "Sonioxの認証に失敗しました。運営者へ連絡してください。",
    );
  }
  if (event.error_code === 402) {
    return new ApplicationError(
      "SONIOX_BUDGET_EXHAUSTED",
      "Sonioxの残高または月額上限へ達しました。",
    );
  }
  if (event.error_code === 429) {
    return new ApplicationError(
      "SONIOX_LIMIT_EXCEEDED",
      "Sonioxの同時実行上限へ達しました。",
    );
  }
  return new ApplicationError(
    "SONIOX_STREAM_FAILED",
    "Sonioxの翻訳音声生成に失敗しました。",
  );
}

function pcmDurationMs(byteLength: number): number {
  return Math.ceil((byteLength * 1000) / (48_000 * 2));
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class RawSonioxTtsGateway implements TtsGateway {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #voices: Readonly<Record<Language, string>>;
  readonly #terminationTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #ledger: TtsUsageLedger;
  readonly #createRequestRef: () => string;
  readonly #now: () => Date;

  public constructor(options: RawSonioxTtsGatewayOptions) {
    this.#url = options.url;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#voices = options.voices;
    this.#terminationTimeoutMs = options.terminationTimeoutMs;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.#ledger = options.ledger;
    this.#createRequestRef = options.createRequestRef ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  public async synthesize(input: {
    utteranceId: string;
    sessionId: string;
    speakerUserId: string;
    language: Language;
    text: string;
  }): Promise<SynthesizedSpeech> {
    const requestRef = this.#createRequestRef();
    const startedAt = this.#now();
    this.#ledger.openProviderRequest({
      requestRef,
      sessionId: input.sessionId,
      userId: input.speakerUserId,
      kind: "tts",
      startedAt,
    });

    const socket = new WebSocket(this.#url, {
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
    });
    const audio = new PassThrough();
    let receivedAudioBytes = 0;
    let audioEnded = false;
    let settled = false;
    let canceled = false;
    let providerError: ApplicationError | undefined;
    const timers: { inactivity?: NodeJS.Timeout } = {};
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const finish = (status: "completed" | "failed", error?: ApplicationError): void => {
      if (settled) return;
      settled = true;
      if (timers.inactivity) clearTimeout(timers.inactivity);
      if (!audioEnded) audio.end();
      const endedAt = this.#now();
      let completionError = error;
      try {
        this.#ledger.recordProviderUsage({
          requestRef,
          audioMs: pcmDurationMs(receivedAudioBytes),
          textCharacterCount: Array.from(input.text).length,
          at: endedAt,
        });
      } catch (ledgerError) {
        completionError = ledgerError instanceof ApplicationError
          ? ledgerError
          : new ApplicationError(
              "USAGE_LEDGER_UNAVAILABLE",
              "利用量台帳へ書き込めないため、翻訳を停止します。",
              { cause: ledgerError },
            );
      }
      try {
        this.#ledger.finishProviderRequest(requestRef, status, endedAt);
      } catch (ledgerError) {
        completionError ??= new ApplicationError(
          "USAGE_LEDGER_UNAVAILABLE",
          "利用量台帳へ書き込めないため、翻訳を停止します。",
          { cause: ledgerError },
        );
      }
      try {
        socket.close();
      } catch {
        // The completion result is already fixed; close is best effort.
      }
      if (completionError && !canceled) {
        rejectCompletion?.(completionError);
      } else {
        resolveCompletion?.();
      }
    };

    const resetInactivityTimeout = (): void => {
      if (timers.inactivity) clearTimeout(timers.inactivity);
      timers.inactivity = setTimeout(() => {
        finish(
          "failed",
          new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTSの応答がタイムアウトしました。",
          ),
        );
      }, this.#terminationTimeoutMs);
      timers.inactivity.unref();
    };

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || settled) return;
      let event: TtsWireEvent;
      try {
        event = JSON.parse(rawDataToUtf8(data)) as TtsWireEvent;
      } catch {
        providerError = new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Sonioxから不正なTTS応答を受信しました。",
        );
        return;
      }
      if (event.stream_id !== input.utteranceId) return;
      resetInactivityTimeout();
      if (event.error_code !== undefined) providerError = mapTtsError(event);
      if (event.audio !== undefined && !providerError) {
        const chunk = Buffer.from(event.audio, "base64");
        receivedAudioBytes += chunk.length;
        audio.write(chunk);
      }
      if (event.audio_end) {
        audioEnded = true;
        audio.end();
      }
      if (event.terminated) {
        if (providerError) {
          finish("failed", providerError);
        } else if (!audioEnded && !canceled) {
          finish(
            "failed",
            new ApplicationError(
              "SONIOX_STREAM_FAILED",
              "Soniox TTSが音声終端なしで終了しました。",
            ),
          );
        } else {
          finish(canceled ? "failed" : "completed");
        }
      }
    });
    socket.on("error", (error) => {
      finish(
        "failed",
        new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTSへ接続できませんでした。",
          { cause: error },
        ),
      );
    });
    socket.on("close", () => {
      if (!settled) {
        finish(
          "failed",
          new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTS接続が予期せず終了しました。",
          ),
        );
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Soniox TTS connection timeout"));
          socket.close();
        }, this.#connectTimeoutMs);
        timer.unref();
        socket.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } catch (error) {
      finish(
        "failed",
        new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTSへ接続できませんでした。",
          { cause: error },
        ),
      );
      await completed;
      throw error;
    }

    socket.send(JSON.stringify({
      api_key: this.#apiKey,
      model: this.#model,
      language: input.language,
      voice: this.#voices[input.language],
      audio_format: "pcm_s16le",
      sample_rate: 48_000,
      stream_id: input.utteranceId,
      client_reference_id: requestRef,
    }));
    socket.send(JSON.stringify({
      stream_id: input.utteranceId,
      text: input.text,
      text_end: true,
    }));
    resetInactivityTimeout();

    return {
      audio,
      completed,
      hasReceivedAudio: () => receivedAudioBytes > 0,
      cancel: () => {
        if (settled) return;
        canceled = true;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            stream_id: input.utteranceId,
            cancel: true,
          }), () => finish("failed"));
          return;
        }
        finish("failed");
      },
    };
  }
}
