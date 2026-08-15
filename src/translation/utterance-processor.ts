import type { Readable } from "node:stream";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";

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
  play(audio: Readable): Promise<void>;
  stop(): void;
};

type QueuedUtterance = {
  utterance: TranslationUtterance;
  enqueuedAt: number;
};

type UtteranceProcessorOptions = {
  captions: CaptionGateway;
  tts: TtsGateway;
  playback: PlaybackGateway;
  maxQueueWaitMs: number;
  maxSourceDurationMs: number;
  maxInputCharacters: number;
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
  readonly #onFatal: (error: ApplicationError) => void;
  readonly #queue: QueuedUtterance[] = [];
  #drainPromise: Promise<void> | undefined;
  #activeSpeech: SynthesizedSpeech | undefined;
  #activeCaption: number | undefined;
  #stopped = false;

  public constructor(options: UtteranceProcessorOptions) {
    this.#captions = options.captions;
    this.#tts = options.tts;
    this.#playback = options.playback;
    this.#maxQueueWaitMs = options.maxQueueWaitMs;
    this.#maxSourceDurationMs = options.maxSourceDurationMs;
    this.#maxInputCharacters = options.maxInputCharacters;
    this.#now = options.now ?? (() => Date.now());
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
    this.#queue.length = 0;
    this.#activeSpeech?.cancel();
    this.#playback.stop();
    if (this.#activeCaption !== undefined) {
      await this.#captions.update(this.#activeCaption, "not_played");
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      const queued = this.#queue.shift();
      if (!queued) return;
      try {
        await this.#process(queued);
      } catch (error) {
        const applicationError = error instanceof ApplicationError
          ? error
          : new ApplicationError(
              "SONIOX_STREAM_FAILED",
              "翻訳音声の生成または再生に失敗しました。",
              { cause: error },
            );
        this.#queue.length = 0;
        this.#onFatal(applicationError);
        return;
      }
    }
  }

  async #process(queued: QueuedUtterance): Promise<void> {
    if (this.#now() - queued.enqueuedAt > this.#maxQueueWaitMs) {
      throw new ApplicationError(
        "PLAYBACK_BACKLOG",
        "PLAYBACK_BACKLOG: 翻訳音声の待ち時間が上限を超えました。",
      );
    }
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

    const caption = await this.#captions.post({
      ...queued.utterance,
      state: "pending",
    });
    this.#activeCaption = caption;
    let speech: SynthesizedSpeech | undefined;
    try {
      speech = await this.#tts.synthesize({
        utteranceId: queued.utterance.utteranceId,
        sessionId: queued.utterance.sessionId,
        speakerUserId: queued.utterance.speakerUserId,
        language: queued.utterance.targetLanguage,
        text: queued.utterance.translatedText,
      });
      this.#activeSpeech = speech;
      await Promise.all([this.#playback.play(speech.audio), speech.completed]);
      await this.#captions.update(caption, "played");
    } catch (error) {
      speech?.cancel();
      this.#playback.stop();
      await this.#captions.update(
        caption,
        speech?.hasReceivedAudio?.() ? "partial_failure" : "not_played",
      );
      throw error;
    } finally {
      this.#activeSpeech = undefined;
      this.#activeCaption = undefined;
    }
  }
}
