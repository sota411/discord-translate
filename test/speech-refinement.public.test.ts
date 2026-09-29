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
  let nativeCancelled = false;
  const service = new SpeechRefinement({
    worker: { begin: () => ({ result: recognized.promise,
      push: (audio: Buffer) => { nativeBytes += audio.length; },
      cancel: () => { nativeCancelled = true; },
    }) } as never,
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
    nativeBytes: () => nativeBytes, nativeCancelled: () => nativeCancelled };
}

void test("到着したPCMから補助認識を進め、全PCMを再認識して確定応答の後だけ原文と訳を置き換える", async () => {
  const h = harness();
  const first = Buffer.alloc(230400, 1), last = Buffer.alloc(67200, 2);
  try {
    h.fence.push(first.subarray(0, 1920), performance.now());
    assert.equal(h.nativeBytes(), 1920);
    assert.equal(h.requests.length, 0);
    h.fence.push(first.subarray(1920), performance.now());
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

void test("短い韓国語は中止確認後に次の話者へ進み、一語だけの途中ヒントも通常結果を返す", async () => {
  for (const complete of [true, false]) {
    const h = harness();
    try {
      h.fence.push(Buffer.alloc(complete ? 96000 : 230400), performance.now());
      h.fence.finalizeRequested("speaking_end");
      h.fence.boundary(primary, h.deliver);
      h.fence.finalized();
      if (complete) {
        assert.equal(h.nativeCancelled(), true);
        assert.equal(h.start(), undefined);
      }
      h.recognized.resolve("창문을");
      await turn();
      if (complete) {
        assert.equal(h.nativeBytes(), 96000);
        const next = h.start();
        assert.ok(next);
        next.close();
      }
      assert.equal(h.requests.length, 0);
      assert.deepEqual(h.output, [primary]);
      assert.deepEqual(h.failures, []);
    } finally { h.fence.close(); }
  }
});

void test("異なる補助原文の平均・最小確信度が両方低い場合だけ初回の原文と訳を残す", async () => {
  for (const scenario of ["lower", "ja-lower", "equal", "mixed", "missing-primary", "missing-secondary", "same-original"] as const) {
    const h = harness();
    const japanese = scenario === "ja-lower";
    const keepPrimary = scenario === "lower" || japanese;
    const first: FinalizedUtterance = japanese
      ? { ...primary, sourceLanguage: "ja", targetLanguage: "ko", originalText: "保証期限が付く", translatedText: "보증 기한이 있다" }
      : primary;
    const fence = japanese ? new RefinementFence(() => h.start({
      hint: { language: "ja", strict: false }, priorAudio: Buffer.alloc(96000),
    })) : h.fence;
    const initial = { ...first, ...(scenario === "missing-primary" ? {} : {
      originalConfidence: { tokenCount: 2, mean: 0.8, min: 0.6 },
    }) };
    const confidence = scenario === "equal" ? [0.6, 1] : scenario === "mixed" ? [0.7, 0.8] : [0.4, 0.6];
    const original = scenario === "same-original" ? first.originalText : japanese ? "補償期限が付く" : "창문을 열었어";
    const translation = japanese ? "보상 기한이 있다" : "窓を開けた";
    try {
      fence.push(Buffer.alloc(288000), performance.now());
      h.recognized.resolve("창문을 열");
      await turn();
      if (japanese) {
        assert.equal(h.nativeBytes(), 0);
        assert.equal(h.provider.finalizeCalls, 1);
        h.provider.emit("finalized");
      }
      fence.finalizeRequested("speaking_end");
      fence.boundary(initial, h.deliver);
      fence.finalized();
      h.provider.emit("result", { tokens: [
        { text: original.slice(0, 3), is_final: true, language: first.sourceLanguage, translation_status: "original",
          ...(scenario === "missing-secondary" ? {} : { confidence: confidence[0] }) },
        { text: original.slice(3), is_final: true, language: first.sourceLanguage, translation_status: "original",
          ...(scenario === "missing-secondary" ? {} : { confidence: confidence[1] }) },
        { text: translation, is_final: true, language: first.targetLanguage, source_language: first.sourceLanguage, translation_status: "translation" },
      ] });
      h.provider.emit("endpoint");
      h.provider.finished.resolve(undefined);
      await turn();
      assert.equal(h.output.length, 1, scenario);
      assert.equal(h.output[0]?.originalText, keepPrimary ? first.originalText : original, scenario);
      assert.equal(h.output[0].translatedText, keepPrimary ? first.translatedText : translation, scenario);
      assert.deepEqual(h.outcomes, [keepPrimary ? "unchanged" : "completed"], scenario);
      assert.deepEqual(h.failures, [], scenario);
    } finally { fence.close(); }
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
    h.recognized.resolve("");
    await turn();
    assert.equal(h.nativeBytes(), priorAudio.length);
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

void test("補助認識の確信度が高くても主認識と翻訳方向が異なる場合は原文と訳を保持する", async () => {
  for (const language of ["ja", "ko"] as const) {
    const h = harness();
    const work = h.start({ hint: { language: "ja", strict: false }, priorAudio: Buffer.alloc(96000) });
    assert.ok(work);
    const first: FinalizedUtterance = language === "ko" ? primary : {
      ...primary, sourceLanguage: "ja", targetLanguage: "ko",
      originalText: "明日見たい", translatedText: "내일 보고 싶어",
    };
    try {
      work.push(Buffer.alloc(144000));
      await turn();
      h.provider.emit("finalized");
      work.finish(performance.now());
      work.choose(first, h.deliver);
      h.provider.emit("result", { tokens: [
        { text: first.translatedText, is_final: true, confidence: 1,
          language: first.targetLanguage, translation_status: "original" },
        { text: first.originalText, is_final: true, confidence: 1,
          language: first.sourceLanguage, source_language: first.targetLanguage, translation_status: "translation" },
      ] });
      h.provider.emit("endpoint");
      h.provider.finished.resolve(undefined);
      await turn();
      assert.deepEqual(h.output, [first]);
      assert.deepEqual(h.outcomes, ["unchanged"]);
      assert.deepEqual(h.failures, []);
    } finally { work.close(); }
  }
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
