import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";
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
  readonly #languages: readonly [Language, Language];
  #prefetch: TtsBatchPrefetch | undefined;
  #prefetchLanguage: Language | undefined;

  public constructor(options: StreamingUtteranceOptions) {
    this.#assembler = new TranslationTokenAssembler(options.pair, {
      maxSourceDurationMs: options.maxSourceDurationMs,
      maxInputCharacters: options.maxInputCharacters,
    });
    this.#createPrefetch = (targetLanguage) => {
      return options.createPrefetch(targetLanguage);
    };
    this.#languages = languagesForPair(options.pair);
  }

  public accept(tokens: readonly TranslationToken[]): boolean {
    let translatedBatch = "";
    let targetLanguage: Language | undefined;
    let prewarmLanguage: Language | undefined;
    for (const token of tokens) {
      if (
        token.is_final &&
        token.translation_status === "original" &&
        this.#isPairLanguage(token.language)
      ) {
        prewarmLanguage ??= this.#otherLanguage(token.language);
      }
      const accepted = this.#assembler.accept(token);
      if (!accepted) continue;
      translatedBatch += accepted.text;
      targetLanguage ??= accepted.targetLanguage;
    }
    const requestedLanguage = targetLanguage ?? prewarmLanguage;
    if (!requestedLanguage) return false;
    if (
      this.#prefetchLanguage !== undefined &&
      this.#prefetchLanguage !== requestedLanguage
    ) {
      throw new Error("同じ発話内で翻訳方向が変化したためTTSを先読みできません");
    }

    const prefetchStarted = this.#prefetch === undefined;
    if (!this.#prefetch) {
      this.#prefetch = this.#createPrefetch(requestedLanguage);
      this.#prefetchLanguage = requestedLanguage;
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
    this.#prefetchLanguage = undefined;
    return endpoint;
  }

  public discard(): TtsBatchPrefetch | undefined {
    this.#assembler.flush();
    const prefetch = this.#prefetch;
    this.#prefetch = undefined;
    this.#prefetchLanguage = undefined;
    return prefetch;
  }

  #isPairLanguage(language: string | undefined): language is Language {
    return language !== undefined && this.#languages.includes(language as Language);
  }

  #otherLanguage(language: Language): Language {
    return this.#languages[0] === language
      ? this.#languages[1]
      : this.#languages[0];
  }
}
