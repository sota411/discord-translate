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
  public finalizeCalls = 0;
  public connect(): Promise<void> { this.connected = true; return Promise.resolve(); }
  public sendAudio(audio: Buffer): void { assert.equal(this.closed, false); this.audio.push(Buffer.from(audio)); }
  public finish(): Promise<void> { return this.finished.promise; }
  public finalize(): Promise<void> { this.finalizeCalls += 1; return Promise.resolve(); }
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
  const start = (options: Partial<Pick<Parameters<SpeechRefinement["start"]>[0], "hint" | "priorAudio">> = {}) => service.start({ session: { sessionId: "session", guildId: "guild", pair: "ja-ko" },
    userId: "speaker", hint: { language: "ko", strict: false }, terms: [],
    observe: (outcome) => outcomes.push(outcome), onError: (error) => failures.push(error), ...options });
  const fence = new RefinementFence(start);
  const deliver = (value: FinalizedUtterance) => output.push(value);
  return { provider, recognized, requests, usage, failures, output, outcomes, start, fence, deliver,
    nativeBytes: () => nativeBytes };
}

void test("2.4秒で補助認識を始め、全PCMを再認識して確定応答の後だけ原文と訳を置き換える", async () => {
  const h = harness();
  const first = Buffer.alloc(230400, 1), last = Buffer.alloc(67200, 2);
  try {
    h.fence.push(first, performance.now());
    assert.equal(h.nativeBytes(), first.length);
    assert.equal(h.start(), undefined);
    h.recognized.resolve("창문을 열");
    await turn();
    assert.equal(h.provider.connected, true);
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

void test("短い韓国語は次の話者を待たせず、一語だけの途中ヒントも通常結果を返す", async () => {
  for (const complete of [true, false]) {
    const h = harness();
    try {
      h.fence.push(Buffer.alloc(complete ? 96000 : 230400), performance.now());
      h.fence.finalizeRequested("speaking_end");
      h.fence.boundary(primary, h.deliver);
      h.fence.finalized();
      h.recognized.resolve("창문을");
      await turn();
      if (complete) assert.equal(h.nativeBytes(), 0);
      assert.equal(h.requests.length, 0);
      assert.deepEqual(h.output, [primary]);
      assert.deepEqual(h.failures, []);
    } finally { h.fence.close(); }
  }
});

void test("短い相手の発話後に音声文脈を渡し、確定境界を越えた本人の原文と訳だけを返す", async () => {
  const h = harness();
  const priorAudio = Buffer.alloc(96000, 1), target = Buffer.alloc(144000, 2);
  const next = new RefinementFence(() => h.start({ hint: { language: "ja", strict: false }, priorAudio }));
  try {
    h.fence.push(priorAudio, performance.now());
    h.fence.finalizeRequested("speaking_end");
    h.fence.boundary(primary, h.deliver);
    h.fence.finalized();
    await turn();
    assert.equal(h.nativeBytes(), 0);
    assert.deepEqual(h.output, [primary]);
    h.output.length = 0;
    next.push(target, performance.now());
    await turn();
    assert.equal(h.provider.finalizeCalls, 1);
    assert.deepEqual(Buffer.concat(h.provider.audio), priorAudio);
    assert.deepEqual(h.requests[0]?.language_hints, ["ja", "ko"]);
    h.provider.emit("result", { tokens: [
      { text: "先行発話", is_final: true, language: "ja", translation_status: "original" },
      { text: "문맥", is_final: true, language: "ko", translation_status: "translation" },
    ] });
    h.provider.emit("endpoint");
    h.provider.emit("finalized");
    next.finalizeRequested("speaking_end");
    next.boundary(primary, h.deliver);
    next.finalized();
    h.provider.complete();
    await turn();
    assert.equal(h.output.length, 1);
    assert.equal(h.output[0]?.originalText, "창문을 열었어");
    assert.equal(h.output[0].translatedText, "窓を開けた");
    assert.deepEqual(Buffer.concat(h.provider.audio), Buffer.concat([priorAudio, target, Buffer.alloc(19200)]));
    assert.ok((h.usage[0]?.audioMs ?? 0) >= 2700);
    assert.deepEqual(h.failures, []);
  } finally { h.fence.close(); next.close(); }
});

void test("音声文脈がない日本語・言語未設定では補助処理を開始しない", () => {
  const h = harness();
  assert.equal(h.start({ hint: { language: "ja", strict: false } }), undefined);
  assert.equal(h.start({ hint: undefined }), undefined);
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
