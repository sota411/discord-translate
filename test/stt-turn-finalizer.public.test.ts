import assert from "node:assert/strict";
import { test } from "node:test";

import { SttTurnFinalizer } from "../src/audio/stt-turn-finalizer.js";

type FinalizeCall =
  | { kind: "audio"; audio: Buffer }
  | { kind: "finalize"; trailingSilenceMs: number | undefined };

function recordingSession(calls: FinalizeCall[]) {
  return {
    sendAudio: (audio: Uint8Array) => {
      calls.push({ kind: "audio", audio: Buffer.from(audio) });
    },
    finalize: (options?: { trailing_silence_ms?: number }) => {
      calls.push({
        kind: "finalize",
        trailingSilenceMs: options?.trailing_silence_ms,
      });
    },
  };
}

void test("Discordの発話再開時は確定を取り消し、終了後200ms相当の無音を送って確定する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(99);
  finalizer.speakingStarted();
  context.mock.timers.tick(1);
  assert.equal(calls.length, 0);

  finalizer.speakingEnded();
  context.mock.timers.tick(100);

  assert.equal(calls.length, 2);
  const audioCall = calls[0];
  assert.ok(audioCall?.kind === "audio");
  assert.equal(audioCall.audio.length, 48_000 * 2 * 0.2);
  assert.ok(audioCall.audio.every((sample) => sample === 0));
  assert.deepEqual(calls[1], { kind: "finalize", trailingSilenceMs: 200 });
  assert.equal(finalizer.boundaryReceived("finalized"), true);
  finalizer.close();
});

void test("Discordの終了イベントがなくても認識テキストが3秒進まなければ確定する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.speakingStarted();
  finalizer.audioReceived();
  finalizer.transcriptProgressed();
  context.mock.timers.tick(2_999);
  finalizer.transcriptProgressed();
  context.mock.timers.tick(2_999);
  assert.equal(calls.length, 0);
  context.mock.timers.tick(1);

  assert.deepEqual(calls.map((call) => call.kind), ["audio", "finalize"]);
  finalizer.close();
});

void test("STT接続待ち中に発話が終わってもbuffer音声の到着後に確定を予約する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.speakingStarted();
  finalizer.speakingEnded();
  finalizer.audioReceived();
  context.mock.timers.tick(100);

  assert.deepEqual(calls.map((call) => call.kind), ["audio", "finalize"]);
  finalizer.close();
});

void test("semantic endpointが先に届いた場合は予約と後続のfinalized markerを重複処理しない", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.audioReceived();
  finalizer.speakingEnded();
  assert.equal(finalizer.boundaryReceived("endpoint"), true);
  context.mock.timers.tick(100);
  assert.equal(calls.length, 0);

  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);
  assert.equal(finalizer.boundaryReceived("endpoint"), true);
  assert.equal(finalizer.boundaryReceived("finalized"), false);
  finalizer.close();
});

void test("manual finalizeをsemantic endpointが連続で先取りしても各finalized markerを無視する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  for (let turn = 0; turn < 2; turn += 1) {
    finalizer.audioReceived();
    finalizer.speakingEnded();
    context.mock.timers.tick(100);
    assert.equal(finalizer.boundaryReceived("endpoint"), true);
  }

  assert.equal(finalizer.boundaryReceived("finalized"), false);
  assert.equal(finalizer.boundaryReceived("finalized"), false);
  finalizer.close();
});

void test("発話中にsemantic endpointが届いても直後の短い発話を確定できる", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.speakingStarted();
  finalizer.audioReceived();
  assert.equal(finalizer.boundaryReceived("endpoint"), true);
  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);

  assert.deepEqual(calls.map((call) => call.kind), ["audio", "finalize"]);
  finalizer.close();
});

void test("manual finalizeの応答待ち中に終わった次の短い発話も応答後に確定する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 1);

  finalizer.speakingStarted();
  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 1);

  assert.equal(finalizer.boundaryReceived("finalized"), true);
  context.mock.timers.tick(100);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 2);
  finalizer.close();
});

void test("manual finalizeの応答待ち中に次発話の認識が進んだ場合も停滞監視を再開する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);

  finalizer.speakingStarted();
  finalizer.audioReceived();
  finalizer.transcriptProgressed();
  assert.equal(finalizer.boundaryReceived("finalized"), true);
  context.mock.timers.tick(2_999);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 1);
  context.mock.timers.tick(1);

  assert.equal(calls.filter((call) => call.kind === "finalize").length, 2);
  finalizer.close();
});

void test("manual finalize後の同一発話の遅延認識だけでは次発話の停滞監視を始めない", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 30_000,
    trailingSilenceMs: 200,
  });

  finalizer.audioReceived();
  finalizer.speakingEnded();
  context.mock.timers.tick(100);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 1);

  finalizer.transcriptProgressed();
  assert.equal(finalizer.boundaryReceived("finalized"), true);
  context.mock.timers.tick(2_500);

  finalizer.speakingStarted();
  finalizer.audioReceived();
  context.mock.timers.tick(500);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 1);

  finalizer.speakingEnded();
  context.mock.timers.tick(100);
  assert.equal(calls.filter((call) => call.kind === "finalize").length, 2);
  finalizer.close();
});

void test("ノイズの誤認識でテキストが進み続けても発話時間上限で確定する", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: FinalizeCall[] = [];
  const reasons: string[] = [];
  const finalizer = new SttTurnFinalizer({
    session: recordingSession(calls),
    speakingEndDelayMs: 100,
    transcriptInactivityMs: 3_000,
    maxTurnMs: 10_000,
    trailingSilenceMs: 200,
    onFinalize: (reason) => reasons.push(reason),
  });

  finalizer.speakingStarted();
  finalizer.audioReceived();
  finalizer.transcriptProgressed();
  for (let elapsed = 0; elapsed < 9_000; elapsed += 2_000) {
    context.mock.timers.tick(2_000);
    finalizer.transcriptProgressed();
  }

  assert.deepEqual(calls.map((call) => call.kind), ["audio", "finalize"]);
  assert.deepEqual(reasons, ["max_turn_duration"]);
  finalizer.close();
});
