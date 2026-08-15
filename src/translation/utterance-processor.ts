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
  playbackDone: Promise<void>;
  playbackFinished: boolean;
  failure: Error | undefined;
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

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function captionStateAfterPlayback(
  playbackWasStarted: boolean,
  playbackCompleted: boolean,
  speech: SynthesizedSpeech | undefined,
): CaptionState {
  if (playbackCompleted) return "played";
  return playbackWasStarted && speech?.hasReceivedAudio?.()
    ? "partial_failure"
    : "not_played";
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
  readonly #stopRequested = createSignal();
  #drainPromise: Promise<void> | undefined;
  #queueWake: (() => void) | undefined;
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
    this.#wakeDrain();
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
    this.#stopRequested.resolve();
    for (const queued of this.#queue) {
      this.#latency?.finish(queued.utterance.utteranceId);
    }
    this.#queue.length = 0;
    this.#wakeDrain();
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
          await this.#waitForQueueOrCompletion(previous);
          continue;
        }

        this.#latency?.mark(queued.utterance.utteranceId, "queue_started");
        const task = this.#startTask(
          queued,
          previous,
          previous !== undefined && !previous.playbackFinished,
        );
        previous = task;
        await Promise.all([task.generationDone, task.playbackStarted]);
      }
      if (previous) await previous.done;
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
    const playbackDone = createSignal();
    const task: ProcessingTask = {
      done: Promise.resolve(),
      generationDone: generation.promise,
      playbackStarted: playback.promise,
      playbackDone: playbackDone.promise,
      playbackFinished: false,
      failure: undefined,
      finished: false,
    };
    void task.playbackDone.catch(() => undefined);
    const previousDone = previous?.done ?? Promise.resolve();
    const processing = this.#process(
      queued,
      previous?.playbackDone ?? Promise.resolve(),
      previousDone,
      () => previous?.failure,
      prefetch,
      generation,
      playback,
      playbackDone,
      () => {
        task.playbackFinished = true;
      },
    );
    task.done = processing.then(
      () => this.#hasStopped() ? undefined : previousDone,
    ).finally(() => {
      task.finished = true;
      this.#tasks.delete(task);
      this.#latency?.finish(queued.utterance.utteranceId);
    });
    void task.done.catch((error: unknown) => {
      const normalized = asError(error, "発話の処理に失敗しました。");
      task.failure = normalized;
      task.playbackFinished = true;
      generation.reject(normalized);
      playback.reject(normalized);
      playbackDone.reject(normalized);
    });
    this.#tasks.add(task);
    return task;
  }

  async #process(
    queued: QueuedUtterance,
    previousPlayback: Promise<void>,
    previousDone: Promise<void>,
    previousFailure: () => Error | undefined,
    prefetch: boolean,
    generation: Signal,
    playback: Signal,
    playbackDone: Signal,
    markPlaybackFinished: () => void,
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
    let captionPromise: Promise<number> | undefined;
    let captionFailure: Error | undefined;
    let speech: SynthesizedSpeech | undefined;
    let playbackWasStarted = false;
    let playbackCompleted = false;
    let playbackStopRequested = false;
    try {
      captionPromise = this.#captions.post({
        ...queued.utterance,
        state: "pending",
      }).then((reference) => {
        caption = reference;
        this.#latency?.mark(queued.utterance.utteranceId, "caption_posted");
        return reference;
      });
      void captionPromise.catch((error: unknown) => {
        captionFailure = asError(error, "Discord字幕POSTに失敗しました。");
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

      const preparedSpeech = await speechPromise;
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
        markPlaybackFinished();
        playbackDone.resolve();
        this.#updateCaptionAfterStop(captionPromise, caption, "not_played");
        if (
          completion.status === "rejected" &&
          isUsageAccountingError(completion.reason)
        ) {
          throw completion.reason;
        }
        return;
      }

      this.#assertQueueWaitWithinLimit(queued);
      if (captionFailure) throw captionFailure;
      const previousError = previousFailure();
      if (previousError) throw previousError;
      playbackWasStarted = true;
      const playbackWork = this.#playback.play(
        audio,
        queued.utterance.utteranceId,
      ).then(
        () => {
          playbackCompleted = !this.#hasStopped() && !playbackStopRequested;
          markPlaybackFinished();
          playbackDone.resolve();
        },
        (error: unknown) => {
          const normalized = asError(error, "翻訳音声の再生に失敗しました。");
          markPlaybackFinished();
          playbackDone.reject(normalized);
          throw normalized;
        },
      );
      playback.resolve();
      const [captionReference] = await Promise.all([
        this.#awaitOrStop(captionPromise),
        playbackWork,
        generationWork,
        this.#awaitOrStop(previousDone),
      ]);
      if (this.#hasStopped()) {
        this.#updateCaptionAfterStop(
          captionPromise,
          caption,
          captionStateAfterPlayback(
            playbackWasStarted,
            playbackCompleted,
            speech,
          ),
        );
      } else {
        if (captionReference === undefined) {
          throw new Error("字幕POSTの完了状態を判定できませんでした。");
        }
        caption = captionReference;
        await this.#captions.update(caption, "played");
      }
    } catch (error) {
      generation.reject(error);
      playback.reject(error);
      markPlaybackFinished();
      playbackDone.reject(error);
      speech?.cancel();
      if (playbackWasStarted) {
        playbackStopRequested = true;
        this.#playback.stop();
      }
      let completionError: unknown;
      if (speech) {
        const [completion] = await Promise.allSettled([speech.completed]);
        if (completion.status === "rejected") completionError = completion.reason;
      }
      if (this.#hasStopped()) {
        if (captionPromise) {
          this.#updateCaptionAfterStop(
            captionPromise,
            caption,
            captionStateAfterPlayback(
              playbackWasStarted,
              playbackCompleted,
              speech,
            ),
          );
        }
        if (isUsageAccountingError(completionError)) throw completionError;
        if (isUsageAccountingError(error)) throw error;
        return;
      }
      if (caption === undefined && captionPromise) {
        const [captionResult] = await Promise.allSettled([captionPromise]);
        if (captionResult.status === "fulfilled") caption = captionResult.value;
      }
      if (caption !== undefined) {
        await this.#captions.update(
          caption,
          captionStateAfterPlayback(
            playbackWasStarted,
            playbackCompleted,
            speech,
          ),
        );
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

  #awaitOrStop<T>(promise: Promise<T>): Promise<T | undefined> {
    if (this.#hasStopped()) return Promise.resolve(undefined);
    return Promise.race([
      promise,
      this.#stopRequested.promise.then(() => undefined),
    ]);
  }

  #updateCaptionAfterStop(
    captionPromise: Promise<number>,
    caption: number | undefined,
    state: CaptionState,
  ): void {
    void Promise.resolve().then(async () => {
      const reference = caption ?? await captionPromise;
      await this.#captions.update(reference, state);
    }).catch(() => undefined);
  }

  #waitForQueueOrCompletion(previous: ProcessingTask): Promise<void> {
    if (this.#queue.length > 0 || this.#stopped || previous.finished) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (this.#queueWake === wake) this.#queueWake = undefined;
        callback();
      };
      const wake = (): void => settle(resolve);
      this.#queueWake = wake;
      void previous.done.then(
        wake,
        (error: unknown) => settle(() => reject(asError(
          error,
          "先行発話の処理に失敗しました。",
        ))),
      );
    });
  }

  #wakeDrain(): void {
    const wake = this.#queueWake;
    this.#queueWake = undefined;
    wake?.();
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
