import type { Language, LanguagePair } from "../domain/language-pair.js";
import type { TtsBatchPrefetch } from "./tts-batch-prefetch.js";
import {
  TranslationTokenAssembler,
  type FinalizedUtterance,
  type TranslationToken,
} from "./token-assembler.js";

type StreamingUtteranceOptions = {
  pair: LanguagePair;
  maxSourceDurationMs: number;
  maxInputCharacters: number;
  createPrefetch(targetLanguage: Language): TtsBatchPrefetch;
};

export type StreamingUtteranceEndpoint = {
  finalized: FinalizedUtterance | undefined;
  prefetch: TtsBatchPrefetch | undefined;
};

export class StreamingUtterance {
  readonly #assembler: TranslationTokenAssembler;
  readonly #createPrefetch: (targetLanguage: Language) => TtsBatchPrefetch;
  #prefetch: TtsBatchPrefetch | undefined;

  public constructor(options: StreamingUtteranceOptions) {
    this.#assembler = new TranslationTokenAssembler(options.pair, {
      maxSourceDurationMs: options.maxSourceDurationMs,
      maxInputCharacters: options.maxInputCharacters,
    });
    this.#createPrefetch = (targetLanguage) => {
      return options.createPrefetch(targetLanguage);
    };
  }

  public accept(tokens: readonly TranslationToken[]): boolean {
    let translatedBatch = "";
    let targetLanguage: Language | undefined;
    for (const token of tokens) {
      const accepted = this.#assembler.accept(token);
      if (!accepted) continue;
      translatedBatch += accepted.text;
      targetLanguage ??= accepted.targetLanguage;
    }
    if (!targetLanguage) return false;

    const prefetchStarted = this.#prefetch === undefined;
    if (!this.#prefetch) {
      this.#prefetch = this.#createPrefetch(targetLanguage);
    }
    if (translatedBatch.length > 0) this.#prefetch.append(translatedBatch);
    return prefetchStarted;
  }

  public takeAtEndpoint(): StreamingUtteranceEndpoint {
    const endpoint = {
      finalized: this.#assembler.flush(),
      prefetch: this.#prefetch,
    };
    this.#prefetch = undefined;
    return endpoint;
  }

  public discard(): TtsBatchPrefetch | undefined {
    this.#assembler.flush();
    const prefetch = this.#prefetch;
    this.#prefetch = undefined;
    return prefetch;
  }

}
