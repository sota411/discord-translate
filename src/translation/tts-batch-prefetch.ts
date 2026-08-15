import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type {
  PreparedSynthesizedSpeech,
  SynthesizedSpeech,
  TtsGateway,
} from "./utterance-processor.js";

type TtsBatchPrefetchOptions = {
  utteranceId: string;
  sessionId: string;
  speakerUserId: string;
  language: Language;
  tts: TtsGateway;
  scheduler?: TtsBatchScheduler;
  maxAudioBytes?: number;
  createSegmentId?: () => string;
};

export type TtsBatchScheduler = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

export class TtsSerialScheduler implements TtsBatchScheduler {
  #tail = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const maxTtsAudioBytes = 48_000 * 2 * 120;

type CompletionSignal = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

type TextSignal = {
  promise: Promise<string | undefined>;
  resolve(text: string | undefined): void;
};

function createCompletionSignal(): CompletionSignal {
  let resolve = (): void => undefined;
  let reject: CompletionSignal["reject"] = () => undefined;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createTextSignal(): TextSignal {
  let resolve: TextSignal["resolve"] = () => undefined;
  const promise = new Promise<string | undefined>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function isUsageAccountingError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError && error.code.startsWith("USAGE_");
}

export class TtsBatchPrefetch {
  public readonly utteranceId: string;

  readonly #sessionId: string;
  readonly #speakerUserId: string;
  readonly #language: Language;
  readonly #tts: TtsGateway;
  readonly #scheduler: TtsBatchScheduler;
  readonly #maxAudioBytes: number;
  readonly #createSegmentId: () => string;
  readonly #audio: PassThrough;
  readonly #completion = createCompletionSignal();
  readonly #speech: SynthesizedSpeech;
  #tail = Promise.resolve();
  #activeSpeech: SynthesizedSpeech | undefined;
  #firstText: TextSignal | undefined;
  #firstTextClaimed = false;
  #receivedAudioBytes = 0;
  #sealed = false;
  #canceled = false;

  public constructor(options: TtsBatchPrefetchOptions) {
    this.utteranceId = options.utteranceId;
    this.#sessionId = options.sessionId;
    this.#speakerUserId = options.speakerUserId;
    this.#language = options.language;
    this.#tts = options.tts;
    this.#scheduler = options.scheduler ?? new TtsSerialScheduler();
    this.#maxAudioBytes = options.maxAudioBytes ?? maxTtsAudioBytes;
    this.#createSegmentId = options.createSegmentId ?? randomUUID;
    this.#audio = new PassThrough({ highWaterMark: this.#maxAudioBytes });
    this.#audio.on("error", () => undefined);
    this.#speech = {
      audio: this.#audio,
      completed: this.#completion.promise,
      cancel: () => this.cancel(),
      hasReceivedAudio: () => this.#receivedAudioBytes > 0,
    };
    void this.#completion.promise.catch(() => undefined);
    if (this.#tts.prepare) this.#startPreparedSegment();
  }

  public append(text: string): void {
    if (this.#sealed) {
      throw new Error("確定済みのTTS先読みへbatchを追加できません");
    }
    if (text.length === 0) return;

    if (this.#firstText && !this.#firstTextClaimed) {
      this.#firstTextClaimed = true;
      this.#firstText.resolve(text);
      return;
    }

    this.#enqueueSegment(text);
  }

  #enqueueSegment(text: string): void {

    const segmentId = this.#createSegmentId();
    const work = this.#tail.then(() => this.#scheduler.run(async () => {
      if (this.#isCanceled()) return;
      const speech = await this.#tts.synthesize({
        utteranceId: segmentId,
        traceId: this.utteranceId,
        sessionId: this.#sessionId,
        speakerUserId: this.#speakerUserId,
        language: this.#language,
        text,
      });
      this.#activeSpeech = speech;
      if (this.#isCanceled()) speech.cancel();

      try {
        await this.#copySpeech(speech);
      } finally {
        if (this.#activeSpeech === speech) this.#activeSpeech = undefined;
      }
    }));
    this.#tail = work;
    void work.catch(() => undefined);
  }

  #startPreparedSegment(): void {
    const firstText = createTextSignal();
    this.#firstText = firstText;
    const segmentId = this.#createSegmentId();
    const work = this.#scheduler.run(async () => {
      if (this.#isCanceled()) return;
      const speech = await this.#tts.prepare?.({
        utteranceId: segmentId,
        traceId: this.utteranceId,
        sessionId: this.#sessionId,
        speakerUserId: this.#speakerUserId,
        language: this.#language,
      });
      if (!speech) {
        throw new Error("TTS gatewayがstreamの先行準備に対応していません");
      }
      this.#activeSpeech = speech;
      try {
        const text = await firstText.promise;
        if (this.#isCanceled() || text === undefined) {
          speech.cancel();
        } else {
          await speech.sendText(text);
        }
        await this.#copySpeech(speech);
      } finally {
        if (this.#activeSpeech === speech) this.#activeSpeech = undefined;
      }
    });
    this.#tail = work;
    void work.catch(() => undefined);
  }

  async #copySpeech(speech: SynthesizedSpeech | PreparedSynthesizedSpeech): Promise<void> {
    for await (const chunk of speech.audio) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      this.#receivedAudioBytes += buffer.length;
      if (this.#receivedAudioBytes > this.#maxAudioBytes) {
        speech.cancel();
        const [completion] = await Promise.allSettled([speech.completed]);
        if (
          completion.status === "rejected" &&
          isUsageAccountingError(completion.reason)
        ) {
          throw completion.reason;
        }
        throw new ApplicationError(
          "TTS_OUTPUT_LIMIT_REACHED",
          "生成音声が先読み上限へ達しました。発話を短く区切ってください。",
        );
      }
      if (!this.#isCanceled()) this.#audio.write(buffer);
    }
    await speech.completed;
  }

  public finish(): SynthesizedSpeech {
    this.#seal();
    return this.#speech;
  }

  public cancel(): void {
    if (this.#canceled) return;
    this.#canceled = true;
    if (this.#firstText && !this.#firstTextClaimed) {
      this.#firstTextClaimed = true;
      this.#firstText.resolve(undefined);
    }
    this.#activeSpeech?.cancel();
    this.#seal();
  }

  public cancelAndWait(): Promise<void> {
    this.cancel();
    return this.#completion.promise;
  }

  public hasReceivedAudio(): boolean {
    return this.#receivedAudioBytes > 0;
  }

  #isCanceled(): boolean {
    return this.#canceled;
  }

  #seal(): void {
    if (this.#sealed) return;
    this.#sealed = true;
    void this.#tail.then(
      () => {
        if (!this.#audio.destroyed) this.#audio.end();
        this.#completion.resolve();
      },
      (error: unknown) => {
        const normalized = error instanceof Error
          ? error
          : new Error("TTS先読み処理に失敗しました", { cause: error });
        if (!this.#audio.destroyed) this.#audio.destroy(normalized);
        this.#completion.reject(normalized);
      },
    );
  }
}
