import type { LanguagePair } from "../domain/language-pair.js";
import {
  TranslationTokenAssembler,
  type FinalizedUtterance,
  type InterimUtterance,
  type TranslationToken,
} from "./token-assembler.js";

type StreamingUtteranceOptions = {
  pair: LanguagePair;
  maxSourceDurationMs: number;
  maxInputCharacters: number;
};

export class StreamingUtterance {
  readonly #assembler: TranslationTokenAssembler;

  public constructor(options: StreamingUtteranceOptions) {
    this.#assembler = new TranslationTokenAssembler(options.pair, {
      maxSourceDurationMs: options.maxSourceDurationMs,
      maxInputCharacters: options.maxInputCharacters,
    });
  }

  public accept(tokens: readonly TranslationToken[]): InterimUtterance | undefined {
    for (const token of tokens) {
      this.#assembler.accept(token);
    }
    return this.#assembler.preview(tokens);
  }

  public takeAtEndpoint(): FinalizedUtterance | undefined {
    return this.#assembler.flush();
  }

  public discard(): void {
    this.#assembler.flush();
  }
}
