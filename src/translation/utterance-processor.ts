import { Readable } from "node:stream";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";
import {
  conversationAudioMaxDelayMs,
  type PlaybackMode,
} from "../session/session-settings.js";

const maxTtsAudioBytes = 48_000 * 2 * 120;

export type CaptionState =
  | "pending"
  | "played"
  | "not_played"
  | "partial_failure"
  | "skipped_delay"
  | "interrupted_for_conversation"
  | "captions_only";

type ControlledInterruptionState = Extract<
  CaptionState,
  "skipped_delay" | "interrupted_for_conversation" | "captions_only"
>;

type IntentionalInterruptionState = Exclude<
  ControlledInterruptionState,
  "skipped_delay"
>;

export type TranslationUtterance = {
  utteranceId: string;
  sessionId: string;
  speakerUserId: string;
  speakerDisplayName: string;
  voiceId: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  originalText: string;
  translatedText: string;
  sourceDurationMs: number;
};

export type CaptionGateway = {
  post(input: TranslationUtterance & { state: CaptionState }): Promise<number | undefined>;
  update(reference: number, state: CaptionState): Promise<void>;
};

export type SynthesizedSpeech = {
  audio: Readable;
  completed: Promise<void>;
  cancel(): void;
  hasReceivedAudio?: () => boolean;
};

export type TtsSynthesisRequest = {
  utteranceId: string;
  traceId?: string;
  sessionId: string;
  speakerUserId: string;
  voiceId: string;
  language: Language;
};

export type TtsGateway = {
  warm?(): void;
  synthesize(
    input: TtsSynthesisRequest & { text: string },
    signal?: AbortSignal,
  ): Promise<SynthesizedSpeech>;
};

export type PlaybackGateway = {
  play(audio: Readable, traceId?: string, onStarted?: () => void): Promise<void>;
  stop(): void;
};

type QueuedUtterance = {
  utterance: TranslationUtterance;
  enqueuedAt: number;
  interruptionState?: IntentionalInterruptionState;
};

class ExpectedPlaybackInterruption extends Error {
  public constructor(
    public readonly state: ControlledInterruptionState,
    cause: unknown,
  ) {
    super("翻訳音声を会話制御によって中断しました。", { cause });
  }
}

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
  playbackMode?: PlaybackMode;
  conversationQueueMaxWaitMs?: number;
  maxSourceDurationMs: number;
  maxInputCharacters: number;
  latency?: TranslationLatencyRecorder;
  now?: () => number;
  onQueueDelay?: (delayMs: number) => void;
  onFatal(error: ApplicationError): void;
};

export class UtteranceProcessor {
  readonly #captions: CaptionGateway;
  readonly #tts: TtsGateway;
  readonly #playback: PlaybackGateway;
  readonly #maxQueueWaitMs: number;
  readonly #conversationQueueMaxWaitMs: number;
  readonly #maxSourceDurationMs: number;
  readonly #maxInputCharacters: number;
  readonly #now: () => number;
  readonly #latency: TranslationLatencyRecorder | undefined;
  readonly #onFatal: (error: ApplicationError) => void;
  readonly #onQueueDelay: (delayMs: number) => void;
  readonly #queue: QueuedUtterance[] = [];
  readonly #waitingSince = new Map<string, number>();
  readonly #tasks = new Set<ProcessingTask>();
  readonly #activeSpeeches = new Set<SynthesizedSpeech>();
  readonly #canceledSpeeches = new WeakSet<SynthesizedSpeech>();
  readonly #trackedSpeechSettlements = new WeakSet<SynthesizedSpeech>();
  readonly #pendingSpeechSettlements = new Set<Promise<void>>();
  readonly #activeTaskControllers = new Map<AbortController, QueuedUtterance>();
  readonly #playbackDeadlinePending = new Set<AbortController>();
  readonly #conversationDeadlineTimers = new Map<AbortController, NodeJS.Timeout>();
  readonly #stopRequested = createSignal();
  readonly #abortController = new AbortController();
  #drainPromise: Promise<void> | undefined;
  #queueWake: (() => void) | undefined;
  #playbackMode: PlaybackMode;
  #audioEnabled = true;
  #stopped = false;
  #usageFailure: ApplicationError | undefined;

  public constructor(options: UtteranceProcessorOptions) {
    this.#captions = options.captions;
    this.#tts = options.tts;
    this.#playback = options.playback;
    this.#maxQueueWaitMs = options.maxQueueWaitMs;
    this.#conversationQueueMaxWaitMs =
      options.conversationQueueMaxWaitMs ?? conversationAudioMaxDelayMs;
    this.#playbackMode = options.playbackMode ?? "conversation";
    this.#maxSourceDurationMs = options.maxSourceDurationMs;
    this.#maxInputCharacters = options.maxInputCharacters;
    this.#now = options.now ?? (() => Date.now());
    this.#latency = options.latency;
    this.#onQueueDelay = options.onQueueDelay ?? (() => undefined);
    this.#onFatal = (error) => options.onFatal(error);
  }

  public enqueue(utterance: TranslationUtterance): void {
    if (this.#stopped) return;
    this.#latency?.mark(utterance.utteranceId, "queue_enqueued");
    const enqueuedAt = this.#now();
    this.#queue.push({
      utterance,
      enqueuedAt,
    });
    this.#waitingSince.set(utterance.utteranceId, enqueuedAt);
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

  public setPlaybackMode(mode: PlaybackMode): void {
    if (this.#playbackMode === mode) return;
    this.#playbackMode = mode;
    if (mode === "accuracy") {
      this.#clearAllConversationDeadlines();
      return;
    }
    for (const [controller, queued] of this.#activeTaskControllers) {
      if (this.#playbackDeadlinePending.has(controller)) {
        this.#armConversationDeadline(queued, controller);
      }
    }
  }

  public setAudioEnabled(enabled: boolean): void {
    if (this.#audioEnabled === enabled) return;
    this.#audioEnabled = enabled;
    if (!enabled) this.#interruptQueuedPlayback("captions_only");
  }

  public interruptForNewSpeech(): void {
    if (this.#playbackMode !== "conversation" || !this.#audioEnabled) return;
    this.#interruptQueuedPlayback("interrupted_for_conversation");
  }

  public currentQueueWaitMs(): number {
    let oldest: number | undefined;
    for (const enqueuedAt of this.#waitingSince.values()) {
      oldest = oldest === undefined ? enqueuedAt : Math.min(oldest, enqueuedAt);
    }
    return oldest === undefined ? 0 : Math.max(0, this.#now() - oldest);
  }

  public isQueueWarningActive(): boolean {
    return this.currentQueueWaitMs() > this.#maxQueueWaitMs;
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearAllConversationDeadlines();
    this.#stopRequested.resolve();
    this.#abortController.abort(
      new DOMException("TTS synthesis aborted", "AbortError"),
    );
    this.#discardQueuedUtterances();
    this.#wakeDrain();
    for (const speech of this.#activeSpeeches) this.#cancelSpeech(speech);
    this.#playback.stop();
    const drainResults = await Promise.allSettled([
      this.#drainPromise ?? Promise.resolve(),
    ]);
    const settlementResults = await Promise.allSettled([
      ...this.#pendingSpeechSettlements,
    ]);
    const cleanupResults = [...drainResults, ...settlementResults];
    if (this.#usageFailure) throw this.#usageFailure;
    const usageFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && isUsageAccountingError(result.reason),
    );
    if (usageFailure) throw usageFailure.reason;
    const failure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
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
      this.#discardQueuedUtterances();
      const cleanupResults = await Promise.allSettled([
        ...[...this.#tasks].map((task) => task.done),
      ]);
      let usageCleanupError: ApplicationError | undefined;
      for (const result of cleanupResults) {
        if (result.status !== "rejected") continue;
        const reason: unknown = result.reason;
        if (isUsageAccountingError(reason)) {
          usageCleanupError = reason;
          break;
        }
      }
      const effectiveError = usageCleanupError ?? error;

      if (this.#hasStopped() && isUsageAccountingError(effectiveError)) {
        throw effectiveError;
      }
      if (this.#hasStopped()) return;

      const applicationError = effectiveError instanceof ApplicationError
        ? effectiveError
        : new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "翻訳音声の生成または再生に失敗しました。",
            { cause: effectiveError },
          );
      this.#onFatal(applicationError);
    }
  }

  #startTask(
    queued: QueuedUtterance,
    previous: ProcessingTask | undefined,
    prepareWhileWaiting: boolean,
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
      prepareWhileWaiting,
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
    prepareWhileWaiting: boolean,
    generation: Signal,
    playback: Signal,
    playbackDone: Signal,
    markPlaybackFinished: () => void,
  ): Promise<void> {
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

    const initialSkipState = this.#skipState(queued);
    if (initialSkipState) {
      this.#waitingSince.delete(queued.utterance.utteranceId);
      const captionWork = this.#captions.post({
        ...queued.utterance,
        state: initialSkipState,
      });
      generation.resolve();
      playback.resolve();
      this.#inheritPreviousPlayback(
        previousPlayback,
        markPlaybackFinished,
        playbackDone,
      );
      await this.#awaitOrStop(captionWork);
      return;
    }

    let caption: number | undefined;
    let captionPromise: Promise<number | undefined> | undefined;
    let captionFailure: Error | undefined;
    let speech: SynthesizedSpeech | undefined;
    const playbackState = { wasStarted: false };
    let playbackRequested = false;
    let playbackCompleted = false;
    let playbackStopRequested = false;
    let playbackWork: Promise<void> | undefined;
    let generationCancellationExpected = false;
    const taskController = new AbortController();
    this.#activeTaskControllers.set(taskController, queued);
    this.#playbackDeadlinePending.add(taskController);
    const onControlledAbort = (): void => {
      if (this.#interruptionState(taskController) !== "skipped_delay") return;
      this.#cancelSpeech(speech);
      if (playbackRequested && !playbackState.wasStarted) {
        playbackStopRequested = true;
        this.#playback.stop();
      }
    };
    taskController.signal.addEventListener("abort", onControlledAbort, { once: true });
    this.#armConversationDeadline(queued, taskController);
    try {
      captionPromise = this.#captions.post({
        ...queued.utterance,
        state: "pending",
      }).then((reference) => {
        caption = reference;
        if (reference !== undefined) {
          this.#latency?.mark(queued.utterance.utteranceId, "caption_posted");
        }
        return reference;
      });
      void captionPromise.catch((error: unknown) => {
        captionFailure = asError(error, "Discord字幕POSTに失敗しました。");
      });
      this.#latency?.mark(queued.utterance.utteranceId, "tts_requested");
      const speechPromise = Promise.resolve(
        this.#tts.synthesize({
          utteranceId: queued.utterance.utteranceId,
          traceId: queued.utterance.utteranceId,
          sessionId: queued.utterance.sessionId,
          speakerUserId: queued.utterance.speakerUserId,
          voiceId: queued.utterance.voiceId,
          language: queued.utterance.targetLanguage,
          text: queued.utterance.translatedText,
        }, AbortSignal.any([
          this.#abortController.signal,
          taskController.signal,
        ])),
      ).then((created) => {
        this.#activeSpeeches.add(created);
        void created.completed.catch(() => undefined);
        void created.completed.then(
          () => this.#latency?.mark(
            queued.utterance.utteranceId,
            "tts_audio_end",
          ),
          () => undefined,
        );
        return created;
      });

      const createdSpeech = await speechPromise;
      speech = createdSpeech;
      const mustBufferWhileWaiting = prepareWhileWaiting;
      const generationWork = mustBufferWhileWaiting
        ? this.#bufferForPlayback(createdSpeech.audio).then(async (audio) => {
            await createdSpeech.completed;
            return audio;
          })
        : createdSpeech.completed.then(() => createdSpeech.audio);
      void generationWork.then(
        () => generation.resolve(),
        (error: unknown) => {
          if (
            generationCancellationExpected ||
            this.#interruptionState(taskController) !== undefined
          ) {
            return;
          }
          generation.reject(error);
        },
      );

      const audioWork = mustBufferWhileWaiting
        ? generationWork
        : Promise.resolve(createdSpeech.audio);
      const audio = await this.#awaitPlaybackReadiness(
        audioWork,
        previousPlayback,
        taskController,
      );
      this.#latency?.mark(queued.utterance.utteranceId, "playback_slot_ready");
      if (this.#hasStopped()) {
        this.#cancelSpeech(speech);
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

      const queueWaitMs = Math.max(0, this.#now() - queued.enqueuedAt);
      if (
        this.#playbackMode === "accuracy" &&
        queueWaitMs > this.#conversationQueueMaxWaitMs
      ) {
        this.#onQueueDelay(queueWaitMs);
      }

      const skipState = this.#skipState(queued, taskController);
      if (skipState) {
        generationCancellationExpected = true;
        this.#cancelSpeech(speech);
        this.#trackSpeechSettlement(speech);
        playback.resolve();
        this.#inheritPreviousPlayback(
          previousPlayback,
          markPlaybackFinished,
          playbackDone,
        );
        this.#waitingSince.delete(queued.utterance.utteranceId);
        generation.resolve();
        const captionReference = await this.#awaitOrStop(captionPromise);
        if (captionReference !== undefined) {
          await this.#awaitOrStop(this.#captions.update(captionReference, skipState));
        }
        return;
      }
      if (captionFailure) throw captionFailure;
      const previousError = previousFailure();
      if (previousError) throw previousError;
      playbackRequested = true;
      playbackWork = this.#playback.play(
        audio,
        queued.utterance.utteranceId,
        () => {
          this.#playbackDeadlinePending.delete(taskController);
          this.#clearConversationDeadline(taskController);
          playbackState.wasStarted = true;
          this.#waitingSince.delete(queued.utterance.utteranceId);
        },
      ).then(
        () => {
          playbackCompleted = !this.#hasStopped() && !playbackStopRequested;
          markPlaybackFinished();
          playbackDone.resolve();
        },
        (error: unknown) => {
          const normalized = asError(error, "翻訳音声の再生に失敗しました。");
          markPlaybackFinished();
          const interruptionState = this.#controlledInterruptionState(
            queued,
            taskController,
          );
          if (interruptionState) {
            playbackDone.resolve();
            throw new ExpectedPlaybackInterruption(interruptionState, normalized);
          }
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
            playbackState.wasStarted,
            playbackCompleted,
            speech,
          ),
        );
      } else {
        if (captionReference !== undefined) {
          caption = captionReference;
          await this.#awaitOrStop(this.#captions.update(caption, "played"));
        }
      }
    } catch (error) {
      const interruptionState = error instanceof ExpectedPlaybackInterruption
        ? error.state
        : this.#controlledInterruptionState(queued, taskController);
      const mustPreserveFailure =
        isUsageAccountingError(error) ||
        (error instanceof ApplicationError && error.code === "CAPTION_SEND_FAILED");
      if (interruptionState && !mustPreserveFailure) {
        generationCancellationExpected = true;
        this.#cancelSpeech(speech);
        this.#trackSpeechSettlement(speech);
        this.#waitingSince.delete(queued.utterance.utteranceId);
        generation.resolve();
        playback.resolve();
        if (playbackRequested && playbackWork) {
          await Promise.allSettled([playbackWork]);
        } else {
          this.#inheritPreviousPlayback(
            previousPlayback,
            markPlaybackFinished,
            playbackDone,
          );
        }
        if (caption === undefined && captionPromise) {
          caption = await this.#awaitOrStop(captionPromise);
        }
        if (caption !== undefined) {
          await this.#awaitOrStop(this.#captions.update(caption, interruptionState));
        }
        return;
      }
      generation.reject(error);
      playback.reject(error);
      markPlaybackFinished();
      playbackDone.reject(error);
      this.#cancelSpeech(speech);
      if (playbackRequested) {
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
              playbackState.wasStarted,
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
        const [captionResult] = await Promise.allSettled([
          this.#awaitOrStop(captionPromise),
        ]);
        if (captionResult.status === "fulfilled") caption = captionResult.value;
      }
      if (caption !== undefined) {
        await this.#awaitOrStop(
          this.#captions.update(
            caption,
            captionStateAfterPlayback(
              playbackState.wasStarted,
              playbackCompleted,
              speech,
            ),
          ),
        );
      }
      if (isUsageAccountingError(completionError)) throw completionError;
      throw error;
    } finally {
      if (speech) this.#activeSpeeches.delete(speech);
      taskController.signal.removeEventListener("abort", onControlledAbort);
      this.#playbackDeadlinePending.delete(taskController);
      this.#clearConversationDeadline(taskController);
      this.#activeTaskControllers.delete(taskController);
      this.#waitingSince.delete(queued.utterance.utteranceId);
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
      if (bytes > maxTtsAudioBytes) {
        throw new ApplicationError(
          "TTS_OUTPUT_LIMIT_REACHED",
          "待機中の生成音声が上限へ達しました。発話を短く区切ってください。",
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
    captionPromise: Promise<number | undefined>,
    caption: number | undefined,
    state: CaptionState,
  ): void {
    void Promise.resolve().then(async () => {
      const reference = caption ?? await captionPromise;
      if (reference !== undefined) await this.#captions.update(reference, state);
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

  #discardQueuedUtterances(): void {
    for (const queued of this.#queue) {
      this.#latency?.finish(queued.utterance.utteranceId);
      this.#waitingSince.delete(queued.utterance.utteranceId);
    }
    this.#queue.length = 0;
  }

  async #awaitPlaybackReadiness(
    audio: Promise<Readable>,
    previousPlayback: Promise<void>,
    controller: AbortController,
  ): Promise<Readable> {
    if (controller.signal.aborted) {
      return Promise.reject(asError(
        controller.signal.reason,
        "翻訳音声の再生準備を中止しました。",
      ));
    }
    const ready = Promise.all([
      audio,
      this.#awaitPreviousPlayback(previousPlayback),
    ]).then(([preparedAudio]) => preparedAudio);
    return new Promise<Readable>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => settle(() => reject(asError(
        controller.signal.reason,
        "翻訳音声の再生準備を中止しました。",
      )));
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        callback();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void ready.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(asError(
          error,
          "翻訳音声の再生準備に失敗しました。",
        ))),
      );
    });
  }

  #armConversationDeadline(
    queued: QueuedUtterance,
    controller: AbortController,
  ): void {
    this.#clearConversationDeadline(controller);
    if (
      this.#playbackMode !== "conversation" ||
      this.#hasStopped() ||
      !this.#playbackDeadlinePending.has(controller) ||
      controller.signal.aborted
    ) {
      return;
    }
    const elapsed = this.#now() - queued.enqueuedAt;
    if (elapsed > this.#conversationQueueMaxWaitMs) {
      controller.abort(new ExpectedPlaybackInterruption("skipped_delay", undefined));
      return;
    }
    const timeoutMs = Math.max(
      1,
      this.#conversationQueueMaxWaitMs - elapsed + 1,
    );
    const timer = setTimeout(() => {
      this.#conversationDeadlineTimers.delete(controller);
      if (
        this.#playbackMode === "conversation" &&
        !this.#hasStopped() &&
        !controller.signal.aborted
      ) {
        controller.abort(new ExpectedPlaybackInterruption("skipped_delay", undefined));
      }
    }, timeoutMs);
    timer.unref();
    this.#conversationDeadlineTimers.set(controller, timer);
  }

  #clearConversationDeadline(controller: AbortController): void {
    const timer = this.#conversationDeadlineTimers.get(controller);
    if (timer) clearTimeout(timer);
    this.#conversationDeadlineTimers.delete(controller);
  }

  #clearAllConversationDeadlines(): void {
    for (const timer of this.#conversationDeadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.#conversationDeadlineTimers.clear();
  }

  #awaitPreviousPlayback(previousPlayback: Promise<void>): Promise<void> {
    if (this.#abortController.signal.aborted) {
      return Promise.reject(asError(
        this.#abortController.signal.reason,
        "再生待ちを中止しました。",
      ));
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#abortController.signal.removeEventListener("abort", onAbort);
        reject(asError(this.#abortController.signal.reason, "再生待ちを中止しました。"));
      };
      this.#abortController.signal.addEventListener("abort", onAbort, { once: true });
      void previousPlayback.then(
        () => {
          this.#abortController.signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          this.#abortController.signal.removeEventListener("abort", onAbort);
          reject(asError(error, "先行発話の再生に失敗しました。"));
        },
      );
    });
  }

  #inheritPreviousPlayback(
    previousPlayback: Promise<void>,
    markPlaybackFinished: () => void,
    playbackDone: Signal,
  ): void {
    void previousPlayback.then(
      () => {
        markPlaybackFinished();
        playbackDone.resolve();
      },
      (error: unknown) => {
        markPlaybackFinished();
        playbackDone.reject(asError(error, "先行発話の再生に失敗しました。"));
      },
    );
  }

  #interruptionState(
    controller: AbortController,
  ): ControlledInterruptionState | undefined {
    const reason: unknown = controller.signal.reason;
    return reason instanceof ExpectedPlaybackInterruption ? reason.state : undefined;
  }

  #skipState(
    queued: QueuedUtterance,
    controller?: AbortController,
  ): Exclude<
    CaptionState,
    "pending" | "played" | "not_played" | "partial_failure"
  > | undefined {
    if (!this.#audioEnabled) return "captions_only";
    const interruptionState = queued.interruptionState ??
      (controller ? this.#interruptionState(controller) : undefined);
    if (interruptionState) return interruptionState;
    if (
      this.#playbackMode === "conversation" &&
      this.#now() - queued.enqueuedAt > this.#conversationQueueMaxWaitMs
    ) {
      return "skipped_delay";
    }
    return undefined;
  }

  #controlledInterruptionState(
    queued: QueuedUtterance,
    controller: AbortController,
  ): ControlledInterruptionState | undefined {
    return queued.interruptionState ?? this.#interruptionState(controller);
  }

  #interruptQueuedPlayback(state: IntentionalInterruptionState): void {
    for (const queued of this.#queue) queued.interruptionState ??= state;
    for (const controller of this.#activeTaskControllers.keys()) {
      if (!controller.signal.aborted) {
        controller.abort(new ExpectedPlaybackInterruption(state, undefined));
      }
    }
    for (const speech of this.#activeSpeeches) this.#cancelSpeech(speech);
    this.#playback.stop();
  }

  #cancelSpeech(speech: SynthesizedSpeech | undefined): void {
    if (!speech || this.#canceledSpeeches.has(speech)) return;
    this.#canceledSpeeches.add(speech);
    speech.cancel();
  }

  #trackSpeechSettlement(speech: SynthesizedSpeech | undefined): void {
    if (!speech || this.#trackedSpeechSettlements.has(speech)) return;
    this.#trackedSpeechSettlements.add(speech);
    const remove = (): void => {
      this.#pendingSpeechSettlements.delete(settlement);
    };
    const settlement = speech.completed.then(
      remove,
      (error: unknown) => {
        remove();
        if (!isUsageAccountingError(error)) return;
        if (this.#usageFailure) return;
        this.#usageFailure = error;
        if (!this.#hasStopped()) this.#onFatal(error);
      },
    );
    this.#pendingSpeechSettlements.add(settlement);
  }

  #hasStopped(): boolean {
    return this.#stopped;
  }
}
