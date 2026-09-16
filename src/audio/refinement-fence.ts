import type { TranslationToken, FinalizedUtterance } from "../translation/token-assembler.js";
import type { SttFinalizeReason } from "./stt-turn-finalizer.js";

export type RefinementWork = {
  push(audio: Buffer): void;
  finish(lastAudioAt: number): void;
  choose(primary: FinalizedUtterance, deliver: (value: FinalizedUtterance) => void): void;
  cancel(): void;
  close(): void;
};
type Turn = { work: RefinementWork; initialBoundary: number; ended: boolean };
type Fence = { bytes: number; turn: Turn | undefined; held?: {
  value: FinalizedUtterance; deliver: (value: FinalizedUtterance) => void;
} };

// A replacement is allowed only after one complete source turn and its manual
// finalize acknowledgment. Later PCM or an earlier natural endpoint invalidates it.
export class RefinementFence {
  readonly #start: () => RefinementWork | undefined;
  readonly #fences: Fence[] = [];
  #turn: Turn | undefined;
  #chosen: RefinementWork | undefined;
  #bytes = 0;
  #acknowledgedBytes = 0;
  #boundaries = 0;
  #lastAudioAt = 0;
  #closed = false;
  readonly #languages = new Set<string>();

  public constructor(start: () => RefinementWork | undefined) { this.#start = start; }

  public needsAcknowledgment(): boolean {
    return !this.#closed && this.#bytes !== this.#acknowledgedBytes && !this.#fences.length;
  }

  public push(audio: Buffer, at: number): void {
    if (this.#closed || !audio.length) return;
    if (audio.length % 2 || !Number.isFinite(at)) throw new TypeError("補助認識のPCMまたは時刻が不正です");
    this.#chosen?.cancel();
    this.#chosen = undefined;
    for (const fence of this.#fences) this.#release(fence);
    if (this.#turn?.ended) { this.#turn.work.cancel(); this.#turn = undefined; }
    if (!this.#turn && this.#bytes === this.#acknowledgedBytes && !this.#fences.length) {
      const work = this.#start();
      if (work) this.#turn = { work, initialBoundary: this.#boundaries, ended: false };
    }
    this.#turn?.work.push(audio);
    this.#bytes += audio.length;
    this.#lastAudioAt = at;
  }

  public accept(tokens: readonly TranslationToken[]): void {
    for (const token of tokens) {
      if (token.is_final && token.translation_status === "original" && token.language &&
          token.text.trim() && !token.text.startsWith("<")) this.#languages.add(token.language);
    }
    if (this.#languages.size <= 1) return;
    this.#turn?.work.cancel();
    this.#turn = undefined;
    for (const fence of this.#fences) this.#release(fence);
  }

  public finalizeRequested(reason: SttFinalizeReason): void {
    if (this.#closed) return;
    if (this.#fences.length >= 16) throw new Error("Sonioxの確定応答が滞留しています");
    const turn = this.#turn;
    this.#turn = undefined;
    if (turn && reason === "speaking_end") {
      turn.ended = true;
      turn.work.finish(this.#lastAudioAt);
      this.#fences.push({ bytes: this.#bytes, turn });
    } else {
      turn?.work.cancel();
      this.#fences.push({ bytes: this.#bytes, turn: undefined });
    }
  }

  public boundary(value: FinalizedUtterance | undefined, deliver: (value: FinalizedUtterance) => void): void {
    if (this.#closed) return;
    this.#boundaries += 1;
    this.#languages.clear();
    const fence = this.#fences[0];
    if (value && fence?.turn && fence.bytes === this.#bytes &&
        this.#boundaries - fence.turn.initialBoundary === 1) {
      fence.held = { value, deliver };
      return;
    }
    this.#turn?.work.cancel();
    this.#turn = undefined;
    for (const pending of this.#fences) this.#release(pending);
    if (value) deliver(value);
  }

  public finalized(): void {
    if (this.#closed) return;
    const fence = this.#fences.shift();
    if (!fence) return;
    if (fence.bytes === this.#bytes) this.#acknowledgedBytes = this.#bytes;
    if (fence.held && fence.turn && fence.bytes === this.#bytes &&
        this.#boundaries - fence.turn.initialBoundary === 1) {
      this.#chosen = fence.turn.work;
      const held = fence.held;
      delete fence.held;
      fence.turn.work.choose(held.value, held.deliver);
    } else this.#release(fence);
  }

  public close(): void {
    this.#closed = true;
    this.#turn?.work.close();
    this.#chosen?.close();
    for (const fence of this.#fences) fence.turn?.work.close();
    this.#fences.length = 0;
    this.#turn = undefined;
    this.#chosen = undefined;
  }

  public cancel(): void {
    this.#turn?.work.cancel();
    this.#turn = undefined;
    this.#chosen?.cancel();
    this.#chosen = undefined;
    for (const fence of this.#fences) this.#release(fence);
  }

  #release(fence: Fence): void {
    fence.turn?.work.cancel();
    fence.turn = undefined;
    const held = fence.held;
    delete fence.held;
    if (held) held.deliver(held.value);
  }
}
