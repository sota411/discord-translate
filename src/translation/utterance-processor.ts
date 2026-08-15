import { Readable } from "node:stream";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";

export type CaptionState = "pending" | "played" | "not_played" | "partial_failure";

export type TranslationUtterance = {
  utteranceId: string;
  sessionId: string;
  speakerUserId: string;
  speakerDisplayName: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  originalText: string;
  translatedText: string;
  sourceDurationMs: number;
};

export type CaptionGateway = {
  post(input: TranslationUtterance & { state: CaptionState }): Promise<number>;
  update(reference: number, state: CaptionState): Promise<void>;
};

export type SynthesizedSpeech = {
  audio: Readable;
  completed: Promise<void>;
  cancel(): void;
  hasReceivedAudio?: () => boolean;
};

export type TtsGateway = {
  synthesize(input: {
    utteranceId: string;
    sessionId: string;
    speakerUserId: string;
    language: Language;
    text: string;
  }): Promise<SynthesizedSpeech>;
};

export type PlaybackGateway = {
  play(audio: Readable, traceId?: string): Promise<void>;
  stop(): void;
};

type QueuedUtterance = {
  utterance: TranslationUtterance;
  enqueuedAt: number;
};

type Signal = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

type ProcessingTask = {
  done: Promise<void>;
  generationDone: Promise<void>;
  playbackStarted: Promise<void>;
  finished: boolean;
};

const maxPrefetchedAudioBytes = 48_000 * 2 * 120;

function createSignal(): Signal {
  let resolve = (): void => undefined;
  let reject: Signal["reject"] = () => undefined;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function isUsageAccountingError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError && error.code.startsWith("USAGE_");
}

type UtteranceProcessorOptions = {
  captions: CaptionGateway;
  tts: TtsGateway;
  playback: PlaybackGateway;
  maxQueueWaitMs: number;
  maxSourceDurationMs: number;
  maxInputCharacters: number;
  latency?: TranslationLatencyRecorder;
  now?: () => number;
  onFatal(error: ApplicationError): void;
};

export class UtteranceProcessor {
  readonly #captions: CaptionGateway;
  readonly #tts: TtsGateway;
  readonly #playback: PlaybackGateway;
  readonly #maxQueueWaitMs: number;
  readonly #maxSourceDurationMs: number;
  readonly #maxInputCharacters: number;
  readonly #now: () => number;
  readonly #latency: TranslationLatencyRecorder | undefined;
  readonly #onFatal: (error: ApplicationError) => void;
  readonly #queue: QueuedUtterance[] = [];
  readonly #tasks = new Set<ProcessingTask>();
  readonly #activeSpeeches = new Set<SynthesizedSpeech>();
  #drainPromise: Promise<void> | undefined;
  #stopped = false;

  public constructor(options: UtteranceProcessorOptions) {
    this.#captions = options.captions;
    this.#tts = options.tts;
    this.#playback = options.playback;
    this.#maxQueueWaitMs = options.maxQueueWaitMs;
    this.#maxSourceDurationMs = options.maxSourceDurationMs;
    this.#maxInputCharacters = options.maxInputCharacters;
    this.#now = options.now ?? (() => Date.now());
    this.#latency = options.latency;
    this.#onFatal = (error) => options.onFatal(error);
  }

  public enqueue(utterance: TranslationUtterance): void {
    if (this.#stopped) return;
    this.#queue.push({ utterance, enqueuedAt: this.#now() });
    if (!this.#drainPromise) {
      this.#drainPromise = this.#drain().finally(() => {
        this.#drainPromise = undefined;
      });
    }
  }

  public async whenIdle(): Promise<void> {
    await this.#drainPromise;
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    for (const queued of this.#queue) {
      this.#latency?.finish(queued.utterance.utteranceId);
    }
    this.#queue.length = 0;
    for (const speech of this.#activeSpeeches) speech.cancel();
    this.#playback.stop();
    await this.#drainPromise;
  }

  async #drain(): Promise<void> {
    let previous: ProcessingTask | undefined;
    try {
      while (!this.#stopped) {
        if (previous?.finished) {
          await previous.done;
          previous = undefined;
        }

        const queued = this.#queue.shift();
        if (!queued) {
          if (!previous) return;
          await previous.done;
          previous = undefined;
          continue;
        }

        this.#latency?.mark(queued.utterance.utteranceId, "queue_started");
        const task = this.#startTask(queued, previous, previous !== undefined);
        previous = task;
        await Promise.all([task.generationDone, task.playbackStarted]);
      }
    } catch (error) {
      for (const queued of this.#queue) {
        this.#latency?.finish(queued.utterance.utteranceId);
      }
      this.#queue.length = 0;
      await Promise.allSettled([...this.#tasks].map((task) => task.done));

      if (this.#hasStopped() && isUsageAccountingError(error)) throw error;
      if (this.#hasStopped()) return;

      const applicationError = error instanceof ApplicationError
        ? error
        : new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "翻訳音声の生成または再生に失敗しました。",
            { cause: error },
          );
      this.#onFatal(applicationError);
    }
  }

  #startTask(
    queued: QueuedUtterance,
    previous: ProcessingTask | undefined,
    prefetch: boolean,
  ): ProcessingTask {
    const generation = createSignal();
    const playback = createSignal();
    const task: ProcessingTask = {
      done: Promise.resolve(),
      generationDone: generation.promise,
      playbackStarted: playback.promise,
      finished: false,
    };
    task.done = this.#process(
      queued,
      previous?.done ?? Promise.resolve(),
      prefetch,
      generation,
      playback,
    ).finally(() => {
      task.finished = true;
      this.#tasks.delete(task);
      this.#latency?.finish(queued.utterance.utteranceId);
    });
    void task.done.catch((error: unknown) => {
      generation.reject(error);
      playback.reject(error);
    });
    this.#tasks.add(task);
    return task;
  }

  async #process(
    queued: QueuedUtterance,
    previousPlayback: Promise<void>,
    prefetch: boolean,
    generation: Signal,
    playback: Signal,
  ): Promise<void> {
    this.#assertQueueWaitWithinLimit(queued);
    const inputCharacters = Array.from(queued.utterance.translatedText).length;
    if (
      queued.utterance.sourceDurationMs > this.#maxSourceDurationMs ||
      inputCharacters > this.#maxInputCharacters
    ) {
      throw new ApplicationError(
        "UTTERANCE_TOO_LONG",
        "UTTERANCE_TOO_LONG: 発話を短く区切って再実行してください。",
      );
    }

    let caption: number | undefined;
    let speech: SynthesizedSpeech | undefined;
    let playbackWasStarted = false;
    try {
      const captionPromise = this.#captions.post({
        ...queued.utterance,
        state: "pending",
      }).then((reference) => {
        this.#latency?.mark(queued.utterance.utteranceId, "caption_posted");
        return reference;
      });
      this.#latency?.mark(queued.utterance.utteranceId, "tts_requested");
      const speechPromise = this.#tts.synthesize({
        utteranceId: queued.utterance.utteranceId,
        sessionId: queued.utterance.sessionId,
        speakerUserId: queued.utterance.speakerUserId,
        language: queued.utterance.targetLanguage,
        text: queued.utterance.translatedText,
      }).then((created) => {
        this.#activeSpeeches.add(created);
        void created.completed.catch(() => undefined);
        return created;
      });

      const [captionResult, speechResult] = await Promise.allSettled([
        captionPromise,
        speechPromise,
      ]);
      if (captionResult.status === "fulfilled") caption = captionResult.value;
      if (speechResult.status === "fulfilled") speech = speechResult.value;
      if (captionResult.status === "rejected" || speechResult.status === "rejected") {
        if (speech) {
          speech.cancel();
          try {
            await speech.completed;
          } catch (completionError) {
            if (isUsageAccountingError(completionError)) throw completionError;
          }
        }
        if (caption !== undefined) await this.#captions.update(caption, "not_played");
        if (speechResult.status === "rejected") throw speechResult.reason;
        if (captionResult.status === "rejected") throw captionResult.reason;
        throw new Error("字幕またはTTSの準備状態を判定できませんでした。");
      }

      caption = captionResult.value;
      const preparedSpeech = speechResult.value;
      speech = preparedSpeech;
      const generationWork = prefetch
        ? this.#bufferForPlayback(preparedSpeech.audio).then(async (audio) => {
            await preparedSpeech.completed;
            return audio;
          })
        : preparedSpeech.completed.then(() => preparedSpeech.audio);
      void generationWork.then(
        () => generation.resolve(),
        (error: unknown) => generation.reject(error),
      );

      const [audio] = await Promise.all([
        prefetch ? generationWork : Promise.resolve(preparedSpeech.audio),
        previousPlayback,
      ]);
      if (this.#hasStopped()) {
        speech.cancel();
        const [completion] = await Promise.allSettled([speech.completed]);
        playback.resolve();
        await this.#captions.update(caption, "not_played");
        if (
          completion.status === "rejected" &&
          isUsageAccountingError(completion.reason)
        ) {
          throw completion.reason;
        }
        return;
      }

      this.#assertQueueWaitWithinLimit(queued);
      playbackWasStarted = true;
      playback.resolve();
      await Promise.all([
        this.#playback.play(audio, queued.utterance.utteranceId),
        generationWork,
      ]);
      if (this.#hasStopped()) {
        await this.#captions.update(
          caption,
          speech.hasReceivedAudio?.() ? "partial_failure" : "not_played",
        );
      } else {
        await this.#captions.update(caption, "played");
      }
    } catch (error) {
      generation.reject(error);
      playback.reject(error);
      speech?.cancel();
      if (playbackWasStarted) this.#playback.stop();
      let completionError: unknown;
      if (speech) {
        const [completion] = await Promise.allSettled([speech.completed]);
        if (completion.status === "rejected") completionError = completion.reason;
      }
      if (caption !== undefined) {
        await this.#captions.update(
          caption,
          playbackWasStarted && speech?.hasReceivedAudio?.()
            ? "partial_failure"
            : "not_played",
        );
      }
      if (this.#hasStopped()) {
        if (isUsageAccountingError(completionError)) throw completionError;
        if (isUsageAccountingError(error)) {
          throw error;
        }
        return;
      }
      if (isUsageAccountingError(completionError)) throw completionError;
      throw error;
    } finally {
      if (speech) this.#activeSpeeches.delete(speech);
    }
  }

  async #bufferForPlayback(audio: Readable): Promise<Readable> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of audio) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxPrefetchedAudioBytes) {
        throw new ApplicationError(
          "TTS_OUTPUT_LIMIT_REACHED",
          "生成音声が先読み上限へ達しました。発話を短く区切ってください。",
        );
      }
      chunks.push(buffer);
    }
    return Readable.from(chunks, { objectMode: false });
  }

  #assertQueueWaitWithinLimit(queued: QueuedUtterance): void {
    if (this.#now() - queued.enqueuedAt <= this.#maxQueueWaitMs) return;
    throw new ApplicationError(
      "PLAYBACK_BACKLOG",
      "PLAYBACK_BACKLOG: 翻訳音声の待ち時間が上限を超えました。",
    );
  }

  #hasStopped(): boolean {
    return this.#stopped;
  }
}
