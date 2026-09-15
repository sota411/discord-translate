import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { RefinementFence } from "../src/audio/refinement-fence.js";
import { SpeechRefinement } from "../src/soniox/speech-refinement.js";
import { SonioxSttFactory } from "../src/soniox/control.js";
import type { FinalizedUtterance } from "../src/translation/token-assembler.js";

const primary: FinalizedUtterance = { sourceLanguage: "ko", targetLanguage: "ja",
  originalText: "문을 열었어", translatedText: "ドアを開けた", sourceDurationMs: 3100 };
class Provider extends EventEmitter {
  public readonly audio: Buffer[] = [];
  public readonly finished = Promise.withResolvers<undefined>();
  public connected = false;
  public closed = false;
  public connect(): Promise<void> { this.connected = true; return Promise.resolve(); }
  public sendAudio(audio: Buffer): void { assert.equal(this.closed, false); this.audio.push(Buffer.from(audio)); }
  public finish(): Promise<void> { return this.finished.promise; }
  public close(): void { this.closed = true; this.finished.reject(new Error("closed")); }
  public complete(): void {
    this.emit("result", { tokens: [
      { text: "창문을 열었어", is_final: true, language: "ko", translation_status: "original" },
      { text: "窓を開けた", is_final: true, language: "ja", source_language: "ko", translation_status: "translation" },
    ] });
    this.emit("endpoint");
    this.finished.resolve(undefined);
  }
}
function harness() {
  const provider = new Provider();
  void provider.finished.promise.catch(() => undefined);
  const recognized = Promise.withResolvers<string>();
  const requests: Record<string, unknown>[] = [];
  const usage: { audioMs: number; textCharacterCount: number }[] = [];
  const failures: unknown[] = [];
  const output: FinalizedUtterance[] = [];
  const outcomes: string[] = [];
  let nativeBytes = 0;
  const service = new SpeechRefinement({
    worker: { transcribe: (audio: Buffer) => { nativeBytes = audio.length; return recognized.promise; } } as never,
    factory: new SonioxSttFactory({ realtime: { stt: (request: Record<string, unknown>) => {
      requests.push(request); return provider;
    } } } as never, "stt-rt-v5"),
    ledger: { assertCanStart: () => Promise.resolve(), openProviderRequest: () => undefined,
      recordProviderUsage: (value: { audioMs: number; textCharacterCount: number }) => usage.push(value),
      finishProviderRequest: () => undefined } as never,
    maxInputCharacters: 1000,
  });
  const start = () => service.start({ session: { sessionId: "session", guildId: "guild", pair: "ja-ko" },
    userId: "speaker", hint: { language: "ko", strict: false }, terms: [],
    observe: (outcome) => outcomes.push(outcome), onError: (error) => failures.push(error) });
  const fence = new RefinementFence(start);
  const deliver = (value: FinalizedUtterance) => output.push(value);
  return { provider, recognized, requests, usage, failures, output, outcomes, start, fence, deliver,
    nativeBytes: () => nativeBytes };
}

void test("同一発話の全PCMを一度ずつ再認識し、確定応答の後だけ原文と訳を同時に置き換える", async () => {
  const h = harness();
  const first = Buffer.alloc(288000, 1), last = Buffer.alloc(9600, 2);
  try {
    h.fence.push(first, performance.now());
    assert.equal(h.nativeBytes(), first.length);
    assert.equal(h.start(), undefined);
    h.recognized.resolve("창문을");
    await turn();
    h.fence.push(last, performance.now());
    h.fence.finalizeRequested("speaking_end");
    h.fence.boundary(primary, h.deliver);
    h.provider.complete();
    await turn();
    assert.equal(h.output.length, 0);
    h.fence.finalized();
    assert.equal(h.output.length, 1);
    assert.equal(h.output[0]?.originalText, "창문을 열었어");
    assert.equal(h.output[0].translatedText, "窓を開けた");
    assert.deepEqual(Buffer.concat(h.provider.audio), Buffer.concat([first, last, Buffer.alloc(19200)]));
    assert.deepEqual(h.requests[0]?.context, { text: "창문을" });
    assert.ok((h.usage[0]?.audioMs ?? 0) >= 3300);
    assert.ok((h.usage[0]?.textCharacterCount ?? 0) > 0);
    assert.deepEqual(h.failures, []);
  } finally { h.fence.close(); }
});

void test("確定待ちの次のPCM、途中endpoint、混在言語では置き換えず、原文を一度だけ返す", async () => {
  for (const scenario of ["later-pcm", "endpoint", "mixed", "left"] as const) {
    const h = harness();
    h.fence.push(Buffer.alloc(288000), performance.now());
    if (scenario === "endpoint") h.fence.boundary(primary, h.deliver);
    if (scenario === "mixed") h.fence.accept([
      { text: "窓", is_final: true, language: "ja", translation_status: "original" },
      { text: "문", is_final: true, language: "ko", translation_status: "original" },
    ]);
    h.fence.finalizeRequested("speaking_end");
    if (scenario !== "endpoint") h.fence.boundary(primary, h.deliver);
    if (scenario === "later-pcm") h.fence.push(Buffer.alloc(1920), performance.now());
    if (scenario === "left") h.fence.close();
    h.fence.finalized();
    h.recognized.resolve("창문을");
    await turn();
    assert.deepEqual(h.output, scenario === "left" ? [] : [primary], scenario);
    assert.equal(h.requests.length, 0, scenario);
    assert.deepEqual(h.failures, []);
    h.fence.close();
  }
});

void test("遅延期限で元の結果を返し、キャンセル中のnative処理を重複起動しない", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  try {
    h.fence.push(Buffer.alloc(288000), performance.now());
    h.fence.finalizeRequested("speaking_end");
    h.fence.boundary(primary, h.deliver);
    h.fence.finalized();
    context.mock.timers.tick(2391);
    assert.deepEqual(h.output, [primary]);
    assert.ok(h.outcomes.includes("deadline"));
    assert.equal(h.start(), undefined);
    h.recognized.resolve("창문을");
    await turn();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.failures, []);
    const next = h.start();
    assert.ok(next);
    next.close();
  } finally { h.fence.close(); context.mock.timers.reset(); }
});
