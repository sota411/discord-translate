import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import WebSocket, { type RawData } from "ws";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";
import type {
  PreparedSynthesizedSpeech,
  SynthesizedSpeech,
  TtsGateway,
  TtsSynthesisRequest,
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
  latency?: TranslationLatencyRecorder;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
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

type ActiveTtsStream = {
  socket?: WebSocket;
  handle(event: TtsWireEvent): void;
  fail(error: ApplicationError): void;
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
  readonly #keepaliveIntervalMs: number;
  readonly #ledger: TtsUsageLedger;
  readonly #latency: TranslationLatencyRecorder | undefined;
  readonly #createRequestRef: () => string;
  readonly #now: () => Date;
  readonly #streams = new Map<string, ActiveTtsStream>();
  #socket: WebSocket | undefined;
  #connectPromise: Promise<WebSocket> | undefined;
  #keepaliveTimer: NodeJS.Timeout | undefined;
  #closed = false;

  public constructor(options: RawSonioxTtsGatewayOptions) {
    this.#url = options.url;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#voices = options.voices;
    this.#terminationTimeoutMs = options.terminationTimeoutMs;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.#keepaliveIntervalMs = options.keepaliveIntervalMs ?? 20_000;
    this.#ledger = options.ledger;
    this.#latency = options.latency;
    this.#createRequestRef = options.createRequestRef ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  public async synthesize(
    input: TtsSynthesisRequest & { text: string },
  ): Promise<SynthesizedSpeech> {
    const prepared = await this.prepare(input);
    await prepared.sendText(input.text);
    return prepared;
  }

  public async prepare(
    input: TtsSynthesisRequest,
  ): Promise<PreparedSynthesizedSpeech> {
    if (this.#closed) {
      throw new ApplicationError(
        "SONIOX_STREAM_FAILED",
        "Soniox TTS接続は終了済みです。",
      );
    }
    if (this.#streams.has(input.utteranceId)) {
      throw new ApplicationError(
        "SONIOX_STREAM_FAILED",
        "同じ発話IDのSoniox TTS streamが既に実行中です。",
      );
    }
    const requestRef = this.#createRequestRef();
    const startedAt = this.#now();
    this.#ledger.openProviderRequest({
      requestRef,
      sessionId: input.sessionId,
      userId: input.speakerUserId,
      kind: "tts",
      startedAt,
    });

    const audio = new PassThrough();
    let receivedAudioBytes = 0;
    let audioEnded = false;
    let settled = false;
    let canceled = false;
    let terminalError: ApplicationError | undefined;
    let sentTextCharacterCount = 0;
    let textSent = false;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const finish = (status: "completed" | "failed", error?: ApplicationError): void => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!audioEnded) audio.end();
      if (this.#streams.get(input.utteranceId) === stream) {
        this.#streams.delete(input.utteranceId);
      }
      const endedAt = this.#now();
      let completionError = error;
      try {
        this.#ledger.recordProviderUsage({
          requestRef,
          audioMs: pcmDurationMs(receivedAudioBytes),
          textCharacterCount: sentTextCharacterCount,
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
      if (completionError) {
        rejectCompletion?.(completionError);
      } else {
        resolveCompletion?.();
      }
    };

    const resetInactivityTimeout = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const timedOutSocket = stream.socket;
        finish(
          "failed",
          terminalError ?? new ApplicationError(
              "SONIOX_STREAM_FAILED",
              "Soniox TTSの応答がタイムアウトしました。",
            ),
        );
        timedOutSocket?.terminate();
      }, this.#terminationTimeoutMs);
      inactivityTimer.unref();
    };

    const stream: ActiveTtsStream = {
      handle: (event) => {
        if (settled) return;
        if (event.error_code !== undefined) {
          terminalError ??= mapTtsError(event);
          resetInactivityTimeout();
          return;
        }
        resetInactivityTimeout();
        if (event.audio !== undefined) {
          const chunk = Buffer.from(event.audio, "base64");
          const isFirstAudio = receivedAudioBytes === 0 && chunk.length > 0;
          receivedAudioBytes += chunk.length;
          audio.write(chunk);
          if (isFirstAudio) {
            this.#latency?.mark(input.traceId ?? input.utteranceId, "tts_first_audio");
          }
        }
        if (event.audio_end) {
          audioEnded = true;
          audio.end();
        }
        if (event.terminated) {
          if (terminalError) {
            finish("failed", terminalError);
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
      },
      fail: (error) => finish("failed", error),
    };
    this.#streams.set(input.utteranceId, stream);

    let socket: WebSocket;
    try {
      socket = await this.#getSocket();
      stream.socket = socket;
      this.#latency?.mark(input.traceId ?? input.utteranceId, "tts_connection_ready");
    } catch (error) {
      const mapped = error instanceof ApplicationError
        ? error
        : new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTSへ接続できませんでした。",
            { cause: error },
          );
      finish(
        "failed",
        mapped,
      );
      await completed;
      throw mapped;
    }

    try {
      await this.#send(socket, {
        api_key: this.#apiKey,
        model: this.#model,
        language: input.language,
        voice: this.#voices[input.language],
        audio_format: "pcm_s16le",
        sample_rate: 48_000,
        reduce_silence: true,
        stream_id: input.utteranceId,
        client_reference_id: requestRef,
      });
      this.#ensureKeepalive(socket);
    } catch (error) {
      const mapped = new ApplicationError(
        "SONIOX_STREAM_FAILED",
        "Soniox TTSへstream設定を送信できませんでした。",
        { cause: error },
      );
      finish(
        "failed",
        mapped,
      );
      await completed;
      throw mapped;
    }

    return {
      audio,
      completed,
      hasReceivedAudio: () => receivedAudioBytes > 0,
      sendText: async (text) => {
        if (settled || textSent) {
          throw new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTS streamへ本文を送信できない状態です。",
          );
        }
        try {
          await this.#send(socket, {
            stream_id: input.utteranceId,
            text,
            text_end: true,
          });
        } catch (error) {
          const mapped = new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTSへ本文を送信できませんでした。",
            { cause: error },
          );
          finish("failed", mapped);
          await completed;
          throw mapped;
        }
        textSent = true;
        sentTextCharacterCount = Array.from(text).length;
        this.#latency?.mark(input.traceId ?? input.utteranceId, "tts_text_sent");
        resetInactivityTimeout();
      },
      cancel: () => {
        if (settled) return;
        canceled = true;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            stream_id: input.utteranceId,
            cancel: true,
          }), (error) => {
            if (error) {
              finish(
                "failed",
                new ApplicationError(
                  "SONIOX_STREAM_FAILED",
                  "Soniox TTSへ取消要求を送信できませんでした。",
                  { cause: error },
                ),
              );
            } else {
              resetInactivityTimeout();
            }
          });
          return;
        }
        finish(
          "failed",
          new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTS接続が終了しているため取消できませんでした。",
          ),
        );
      },
    };
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearKeepalive();
    const error = new ApplicationError(
      "SONIOX_STREAM_FAILED",
      "Soniox TTS接続を終了しました。",
    );
    for (const stream of [...this.#streams.values()]) stream.fail(error);
    this.#socket?.terminate();
    this.#socket = undefined;
  }

  public warm(): void {
    if (this.#closed) return;
    void this.#getSocket().catch(() => undefined);
  }

  async #getSocket(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (this.#connectPromise) return this.#connectPromise;

    const pending = this.#openSocket();
    this.#connectPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.#connectPromise === pending) this.#connectPromise = undefined;
    }
  }

  #openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(this.#url, {
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let event: TtsWireEvent;
      try {
        event = JSON.parse(rawDataToUtf8(data)) as TtsWireEvent;
      } catch {
        this.#failConnection(
          socket,
          new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Sonioxから不正なTTS応答を受信しました。",
          ),
        );
        socket.terminate();
        return;
      }
      if (event.stream_id !== undefined) {
        this.#streams.get(event.stream_id)?.handle(event);
        return;
      }
      if (event.error_code !== undefined) {
        const error = mapTtsError(event);
        for (const stream of this.#streams.values()) {
          if (stream.socket === socket) stream.fail(error);
        }
      }
    });
    socket.on("error", (cause) => {
      this.#failConnection(
        socket,
        new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTSへ接続できませんでした。",
          { cause },
        ),
      );
    });
    socket.on("close", () => {
      this.#failConnection(
        socket,
        new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTS接続が予期せず終了しました。",
        ),
      );
    });

    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTSへの接続がタイムアウトしました。",
        ));
      }, this.#connectTimeoutMs);
      timer.unref();
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#closed) {
          socket.terminate();
          reject(new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "Soniox TTS接続は終了済みです。",
          ));
          return;
        }
        this.#socket = socket;
        resolve(socket);
      });
      socket.once("error", (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTSへ接続できませんでした。",
          { cause },
        ));
      });
      socket.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ApplicationError(
          "SONIOX_STREAM_FAILED",
          "Soniox TTS接続が確立前に終了しました。",
        ));
      });
    });
  }

  #send(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #ensureKeepalive(socket: WebSocket): void {
    if (this.#keepaliveTimer) return;
    this.#keepaliveTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ keep_alive: true }), (error) => {
        if (error) socket.terminate();
      });
    }, this.#keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
  }

  #failConnection(socket: WebSocket, error: ApplicationError): void {
    if (this.#socket === socket) {
      this.#socket = undefined;
      this.#clearKeepalive();
    }
    for (const stream of [...this.#streams.values()]) {
      if (stream.socket === socket) stream.fail(error);
    }
  }

  #clearKeepalive(): void {
    if (!this.#keepaliveTimer) return;
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;
  }
}
