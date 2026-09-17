import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { RealtimeResult } from "@soniox/node";
import { Collection, MessageFlags, REST } from "discord.js";

import { loadConfig } from "../src/config.js";
import type { CaptionMessagePayload } from "../src/discord/caption-gateway.js";
import {
  DiscordTranslationRuntime,
  type TranslationRuntimeOptions,
} from "../src/discord/translation-driver.js";
import type {
  PrivateSttCaptureSession,
  PrivateSttCaptureSpeaker,
} from "../src/diagnostics/private-stt-capture.js";
import { exportThreadToMarkdown } from "../src/discord/thread-export.js";
import { validEnv } from "./helpers/valid-env.js";

class FakeSttSession extends EventEmitter {
  public audioWrites = 0;
  public finalizeCalls = 0;

  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public sendAudio(): void {
    this.audioWrites += 1;
  }

  public keepAlive(): void {
    return undefined;
  }

  public finalize(): Promise<void> {
    this.finalizeCalls += 1;
    return Promise.resolve();
  }

  public close(): void {
    return undefined;
  }
}

const unsupportedResult: RealtimeResult = {
  tokens: [{
    text: "hello",
    confidence: 1,
    is_final: true,
    language: "en",
    translation_status: "none",
  }],
  final_audio_proc_ms: 500,
  total_audio_proc_ms: 500,
};

void test("Runtimeは警告失敗を非致命に扱い、訳文のない確定原文も字幕とexportに残す", {
  timeout: 2_000,
}, async () => {
  const userId = "323456789012345678";
  const replacementUserId = "423456789012345678";
  const speaking = new EventEmitter();
  const opus = new PassThrough();
  const stt = new FakeSttSession();
  const sent: CaptionMessagePayload[] = [];
  const edited: CaptionMessagePayload[] = [];
  let deleted = 0;
  let synthesisCalls = 0;
  let discordUnavailable = true;
  const failures: string[] = [];
  const sttCreateCalls: unknown[][] = [];
  const observedWarning = Promise.withResolvers<{
    guildId: string;
    operation: string;
    cause?: unknown;
  }>();
  const connectionEvents = new EventEmitter();
  const runtime = new DiscordTranslationRuntime({
    session: {
      sessionId: "session-1",
      guildId: "223456789012345678",
      voiceChannelId: "voice-1",
      voiceChannelName: "General",
      textChannelId: "text-1",
      textChannelName: "translation",
      startedByUserId: userId,
      pair: "ja-ko",
      state: "ACTIVE",
      startedAt: new Date("2026-08-18T00:00:00Z"),
      participantIds: [userId],
      playbackMode: "conversation",
      audioEnabled: true,
      captionFailurePolicy: "continue_audio",
    },
    participantIds: [userId],
    translationTerms: [],
    guild: {
      client: { rest: new REST({ hashSweepInterval: 0, handlerSweepInterval: 0 }) },
      members: {
        cache: new Map([
          [userId, { displayName: "Sota" }],
          [replacementUserId, { displayName: "Minji" }],
        ]),
      },
    },
    voiceChannel: {
      members: new Map([[userId, { user: { bot: false } }]]),
    },
    presentation: {
      threadId: "thread-1",
      captionChannel: {
        send(payload: CaptionMessagePayload) {
          sent.push(payload);
          if (discordUnavailable) {
            return Promise.reject(new Error("Discord unavailable"));
          }
          return Promise.resolve({
            edit(next: CaptionMessagePayload) {
              edited.push(next);
              return Promise.resolve();
            },
            delete() {
              deleted += 1;
              return Promise.resolve();
            },
          });
        },
      },
      update: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    connection: {
      receiver: {
        speaking,
        subscribe: () => opus,
      },
      subscribe: () => undefined,
      on: connectionEvents.on.bind(connectionEvents),
      destroy: () => undefined,
    },
    config: loadConfig(validEnv({ SONIOX_REGION: "jp" }), new Date("2026-08-15T00:00:00Z")),
    speakerLanguageHints: new Map([[userId, "ko"]]),
    ledger: {
      openProviderRequest: () => undefined,
      recordProviderUsage: () => undefined,
      finishProviderRequest: () => undefined,
      finishSession: () => undefined,
    },
    sttFactory: {
      create: (...args: unknown[]) => {
        sttCreateCalls.push(args);
        return { session: stt, initialTextCharacterCount: 0 };
      },
    },
    tts: {
      synthesize: () => {
        synthesisCalls += 1;
        return Promise.reject(new Error("Unexpected TTS request"));
      },
    },
    latency: {
      start: () => undefined,
      mark: () => undefined,
      finish: () => undefined,
    },
    observeFlow: () => undefined,
    onFailure: (_guildId: string, reason: string) => failures.push(reason),
    onWarning: (guildId: string, operation: string, cause: unknown) => {
      observedWarning.resolve({ guildId, operation, cause });
    },
  } as unknown as TranslationRuntimeOptions);

  try {
    speaking.emit("start", userId);
    assert.deepEqual(sttCreateCalls[0]?.[3], {
      language: "ko",
      strict: false,
    });
    stt.emit("result", unsupportedResult);

    const warning = await observedWarning.promise;
    assert.equal(warning.guildId, "223456789012345678");
    assert.equal(warning.operation, "unsupported_language_warning");
    assert.equal(sent.length, 1);
    const message = sent[0];
    assert.ok(message);
    assert.equal(message.flags, MessageFlags.IsComponentsV2);
    assert.equal("content" in message, false);

    discordUnavailable = false;
    const previewResult = (original: string, translated: string): RealtimeResult => ({
      tokens: [
        {
          text: original,
          confidence: 1,
          is_final: false,
          language: "ja",
          translation_status: "original",
        },
        {
          text: translated,
          confidence: 1,
          is_final: false,
          language: "ko",
          source_language: "ja",
          translation_status: "translation",
        },
      ],
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
    });
    stt.emit("result", previewResult("明日の", "내일"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stt.emit("result", previewResult("明日の夜", "내일 밤"));
    stt.emit("result", previewResult("明日の夜は空いてる？", "내일 밤에 시간 있어?"));
    await new Promise<void>((resolve) => setTimeout(resolve, 550));

    assert.equal(sent.length, 2);
    assert.equal(edited.length, 1);
    assert.match(JSON.stringify(edited[0]), /明日の夜は空いてる/u);
    assert.match(JSON.stringify(edited[0]), /내일 밤에 시간 있어/u);

    stt.emit("endpoint");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deleted, 1);

    for (const [language, original] of [["ja", "今日は晴れです。"], ["ko", "오늘은 맑아요."]] as const) {
      stt.emit("result", {
        tokens: [{ text: original, confidence: 0.95, is_final: true,
          language, translation_status: "original", start_ms: 0, end_ms: 500 }],
        final_audio_proc_ms: 500,
        total_audio_proc_ms: 500,
      } satisfies RealtimeResult);
      stt.emit("endpoint");
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Audio remains enabled; source-only captions must bypass TTS.
      const finalCaption = [...sent, ...edited].find((payload) => {
        const json = JSON.stringify(payload);
        return json.includes(original) && json.includes("訳文を取得できませんでした");
      });
      assert.ok(finalCaption, `${language}: the finalized original must remain visible`);
      assert.equal(deleted, 1);
      assert.equal(synthesisCalls, 0);
      assert.deepEqual(failures, []);
      const result = await exportThreadToMarkdown({
        botUserId: "bot-user",
        thread: {
          id: "thread-1", name: "translation",
          messages: { fetch: () => Promise.resolve(new Collection([["1", {
            id: "1", author: { id: "bot-user" }, createdAt: new Date(),
            components: finalCaption.components,
          }]])) },
        },
      });
      assert.ok(result.markdown.includes(original));
      assert.match(result.markdown, /訳文を取得できませんでした/u);
    }

    await runtime.setAudioEnabled(false);
    const complete = previewResult("次の発話です。", "다음 발화입니다.");
    stt.emit("result", { ...complete, tokens: complete.tokens.map((token) => ({ ...token, is_final: true })) });
    stt.emit("endpoint");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const nextCaption = [...sent, ...edited].find((payload) => JSON.stringify(payload).includes("📝 字幕のみ"));
    assert.ok(nextCaption);
    assert.match(JSON.stringify(nextCaption), /次の発話です/u);
    assert.doesNotMatch(JSON.stringify(nextCaption), /今日は晴れ|오늘은 맑아요|訳文を取得できませんでした/u);

    await runtime.updateParticipants([replacementUserId]);
    stt.emit("result", {
      tokens: [
        {
          text: "退出後",
          confidence: 1,
          is_final: true,
          language: "ja",
          translation_status: "original",
          start_ms: 0,
          end_ms: 500,
        },
        {
          text: "퇴장 후",
          confidence: 1,
          is_final: true,
          language: "ko",
          source_language: "ja",
          translation_status: "translation",
        },
      ],
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
    } satisfies RealtimeResult);
    stt.emit("endpoint");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, []);
  } finally {
    await runtime.stop("TEST_COMPLETE");
  }
});

void test("Runtimeは音声受信を復旧し、短い無音で再開した発話を分断せず送信する", {
  timeout: 2_000,
}, async () => {
  const userId = "323456789012345678";
  const speaking = new EventEmitter();
  const opusStreams = [new PassThrough(), new PassThrough()];
  let rtpSequence = 0;
  const sendCapturedPacket = (): void => {
    const stream = opusStreams[1];
    assert.ok(stream);
    const packet = Buffer.from([0x00]);
    stream.emit("rtpPacket", packet, { sequence: rtpSequence, timestamp: rtpSequence * 480,
      ssrc: 123, receivedAtMonotonicMs: performance.now() });
    rtpSequence += 1;
    stream.write(packet);
  };
  const stt = new FakeSttSession();
  const failures: string[] = [];
  const warnings: string[] = [];
  const connectionEvents = new EventEmitter();
  let subscriptions = 0;
  const capturedOpus: Buffer[] = [];
  const capturedPcm: { stereoBytes: number; monoBytes: number }[] = [];
  const capturedSonioxAudio: { kind: string; monoBytes: number }[] = [];
  const capturedResults: RealtimeResult["tokens"][] = [];
  const captureReceiveEvents: string[] = [];
  const capturedBoundaries: string[] = [];
  let captureClosed = false;
  const captureSpeaker: PrivateSttCaptureSpeaker = {
    speakingStarted: () => undefined,
    speakingEnded: () => undefined,
    recordOpusPacket: ({ packet }) => {
      capturedOpus.push(Buffer.from(packet));
      return capturedOpus.length - 1;
    },
    recordDecodedPacket: ({ stereoPcm, monoPcm }) => {
      capturedPcm.push({ stereoBytes: stereoPcm.length, monoBytes: monoPcm.length });
    },
    recordSonioxAudio: ({ kind, monoPcm }) => {
      capturedSonioxAudio.push({ kind, monoBytes: monoPcm.length });
    },
    recordDroppedPacket: () => undefined,
    recordReceiveEvent: ({ kind }) => captureReceiveEvents.push(kind),
    recordSttBoundary: ({ kind }) => capturedBoundaries.push(kind),
    recordFinalizeRequested: () => undefined,
    recordSttResult: ({ tokens }) => capturedResults.push([...tokens]),
  };
  const privateCapture: PrivateSttCaptureSession = {
    createSpeaker: () => captureSpeaker,
    close: () => {
      captureClosed = true;
      return Promise.resolve();
    },
  };
  const runtime = new DiscordTranslationRuntime({
    session: {
      sessionId: "session-voice-recovery",
      guildId: "223456789012345678",
      voiceChannelId: "voice-1",
      voiceChannelName: "General",
      textChannelId: "text-1",
      textChannelName: "translation",
      startedByUserId: userId,
      pair: "ja-ko",
      state: "ACTIVE",
      startedAt: new Date("2026-08-20T00:00:00Z"),
      participantIds: [userId],
      playbackMode: "conversation",
      audioEnabled: true,
      captionFailurePolicy: "continue_audio",
    },
    participantIds: [userId],
    translationTerms: [],
    guild: {
      client: { rest: new REST({ hashSweepInterval: 0, handlerSweepInterval: 0 }) },
      members: {
        cache: new Map([[userId, { displayName: "Sota" }]]),
      },
    },
    voiceChannel: {
      members: new Map([[userId, { user: { bot: false } }]]),
    },
    presentation: {
      threadId: "thread-2",
      captionChannel: {
        send: () => Promise.resolve({
          edit: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        }),
      },
      update: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    connection: {
      receiver: {
        speaking,
        subscribe: () => {
          const stream = opusStreams[subscriptions];
          assert.ok(stream);
          subscriptions += 1;
          return stream;
        },
      },
      subscribe: () => undefined,
      on: connectionEvents.on.bind(connectionEvents),
      destroy: () => undefined,
    },
    config: loadConfig(validEnv({ SONIOX_REGION: "jp" }), new Date("2026-08-15T00:00:00Z")),
    speakerLanguageHints: new Map(),
    privateCapture,
    ledger: {
      openProviderRequest: () => undefined,
      recordProviderUsage: () => undefined,
      finishProviderRequest: () => undefined,
      finishSession: () => undefined,
    },
    sttFactory: {
      create: () => ({ session: stt, initialTextCharacterCount: 0 }),
    },
    tts: {},
    latency: {
      start: () => undefined,
      mark: () => undefined,
      finish: () => undefined,
    },
    observeFlow: () => undefined,
    onFailure: (_guildId: string, reason: string) => failures.push(reason),
    onWarning: (_guildId: string, operation: string) => warnings.push(operation),
  } as unknown as TranslationRuntimeOptions);

  try {
    speaking.emit("start", userId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    opusStreams[0]?.destroy(new Error("Failed to decrypt voice packet"));
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    assert.equal(subscriptions, 2);
    sendCapturedPacket();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stt.emit("result", unsupportedResult);
    stt.emit("endpoint");
    await new Promise<void>((resolve) => setImmediate(resolve));

    speaking.emit("start", userId);
    sendCapturedPacket();
    await new Promise<void>((resolve) => setImmediate(resolve));
    speaking.emit("end", userId);
    // A real packet trace resumed 117 ms after Discord's speaking_end event.
    await new Promise<void>((resolve) => setTimeout(resolve, 117));
    assert.equal(stt.audioWrites, 2, "do not insert silence inside a brief pause");
    assert.equal(stt.finalizeCalls, 0, "keep the utterance open across a brief pause");
    speaking.emit("start", userId);
    sendCapturedPacket();
    speaking.emit("end", userId);
    await new Promise<void>((resolve) => setTimeout(resolve, 220));

    assert.equal(stt.audioWrites, 4);
    assert.equal(stt.finalizeCalls, 1);
    assert.deepEqual(capturedOpus, [Buffer.from([0x00]), Buffer.from([0x00]), Buffer.from([0x00])]);
    assert.deepEqual(capturedPcm, [
      { stereoBytes: 1_920, monoBytes: 960 },
      { stereoBytes: 1_920, monoBytes: 960 },
      { stereoBytes: 1_920, monoBytes: 960 },
    ]);
    assert.deepEqual(capturedSonioxAudio, [
      { kind: "decoded_packet", monoBytes: 960 },
      { kind: "decoded_packet", monoBytes: 960 },
      { kind: "decoded_packet", monoBytes: 960 },
      { kind: "trailing_silence", monoBytes: 19_200 },
    ]);
    assert.deepEqual(capturedResults, [unsupportedResult.tokens]);
    assert.deepEqual(capturedBoundaries, ["endpoint"]);
    assert.deepEqual(captureReceiveEvents, [
      "receive_stream_closed",
      "receive_stream_recovered",
    ]);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, ["voice_receive_stream_recovering"]);
  } finally {
    await runtime.stop("TEST_COMPLETE");
  }
  assert.equal(captureClosed, true);
});

void test("Runtimeは途中参加者の原文を分け、過去の音声文脈を提供した話者の退出で補助結果を取り消す", {
  timeout: 3_000,
}, async () => {
  const ja = "323456789012345678", ko = "423456789012345678";
  const speaking = new EventEmitter(), connection = new EventEmitter();
  const streams = new Map([[ja, new PassThrough()], [ko, new PassThrough()]]);
  const members = new Map([[ja, { user: { bot: false } }]]);
  const providers: FakeSttSession[] = [];
  const sent: CaptionMessagePayload[] = [];
  const starts: { userId: string; hint: { language: string }; priorAudio?: Buffer }[] = [];
  const failures: string[] = [];
  let closed = 0;
  const runtime = new DiscordTranslationRuntime({
    session: { sessionId: "refinement", guildId: "223456789012345678", voiceChannelId: "voice",
      voiceChannelName: "General", textChannelId: "text", textChannelName: "translation",
      startedByUserId: ja, pair: "ja-ko", state: "ACTIVE", startedAt: new Date(),
      participantIds: [ja], playbackMode: "conversation", audioEnabled: false,
      captionFailurePolicy: "continue_audio" },
    participantIds: [ja], translationTerms: [],
    guild: { client: { rest: new REST({ hashSweepInterval: 0, handlerSweepInterval: 0 }) },
      members: { cache: new Map([[ja, { displayName: "Sota" }], [ko, { displayName: "Minji" }]]) } },
    voiceChannel: { members },
    presentation: { threadId: "refined-thread", captionChannel: { send: (payload: CaptionMessagePayload) => {
      sent.push(payload); return Promise.resolve({ edit: () => Promise.resolve(), delete: () => Promise.resolve() });
    } }, update: () => Promise.resolve(), close: () => Promise.resolve() },
    connection: { receiver: { speaking, subscribe: (id: string) => streams.get(id) },
      subscribe: () => undefined, on: connection.on.bind(connection), destroy: () => undefined },
    config: loadConfig(validEnv({ SONIOX_REGION: "jp", ALLOWED_USER_IDS: `${ja},${ko}` }), new Date("2026-08-15T00:00:00Z")),
    speakerLanguageHints: new Map([[ja, "ja"], [ko, "ko"]]),
    ledger: { openProviderRequest: () => undefined, recordProviderUsage: () => undefined,
      finishProviderRequest: () => undefined, finishSession: () => undefined },
    sttFactory: { create: () => { const provider = new FakeSttSession(); providers.push(provider);
      return { session: provider, initialTextCharacterCount: 0 }; } },
    refinement: { start: (input: { userId: string; hint: { language: string }; priorAudio?: Buffer }) => {
      starts.push(input);
      return { push: () => undefined, finish: () => undefined, cancel: () => undefined,
        close: () => { closed += 1; },
        choose: (primary: import("../src/translation/token-assembler.js").FinalizedUtterance,
          deliver: (value: import("../src/translation/token-assembler.js").FinalizedUtterance) => void) => {
          deliver({ ...primary, originalText: "補助認識済み", translatedText: "再認識の訳文" });
        } };
    } },
    tts: { synthesize: () => Promise.reject(new Error("Captions-only must not call TTS")) },
    latency: { start: () => undefined, mark: () => undefined, finish: () => undefined },
    observeFlow: () => undefined,
    onFailure: (_guild: string, reason: string, _message: string, cause: unknown) => failures.push(`${reason}: ${_message}: ${String(cause instanceof Error ? cause.stack : cause)}`),
    onWarning: () => undefined,
  } as unknown as TranslationRuntimeOptions);
  const result: RealtimeResult = { tokens: [
    { text: "通常の原文", confidence: 0.5, is_final: true, language: "ko", translation_status: "original" },
    { text: "通常の訳文", confidence: 0.5, is_final: true, language: "ja", source_language: "ko", translation_status: "translation" },
  ], final_audio_proc_ms: 10, total_audio_proc_ms: 10 };
  const startTurn = async (id: string): Promise<void> => {
    speaking.emit("start", id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    streams.get(id)?.write(Buffer.from([0x00]));
    speaking.emit("end", id);
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
  };
  try {
    await runtime.setAudioEnabled(false);
    speaking.emit("start", ja);
    await new Promise<void>((resolve) => setImmediate(resolve));
    streams.get(ja)?.write(Buffer.from([0x00]));
    speaking.emit("end", ja);
    const primary = providers[0];
    assert.ok(primary);
    primary.emit("result", result);
    primary.emit("endpoint");
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    assert.equal(primary.finalizeCalls, 1, "request an acknowledgment after an early natural endpoint");
    primary.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    sent.length = 0;
    starts.length = 0;
    await startTurn(ja);
    primary.emit("result", result);
    primary.emit("endpoint");
    assert.equal(sent.length, 0);
    primary.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]), /補助認識済み/u);
    assert.match(JSON.stringify(sent[0]), /再認識の訳文/u);
    members.set(ko, { user: { bot: false } });
    await runtime.updateParticipants([ja, ko]);
    await startTurn(ko);
    providers[1]?.emit("result", result);
    providers[1]?.emit("endpoint");
    providers[1]?.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.match(JSON.stringify(sent[1]), /Minji/u);
    assert.deepEqual(starts.map(({ userId, hint }) => [userId, hint.language]), [[ja, "ja"], [ko, "ko"]]);
    assert.equal(starts[0]?.priorAudio, undefined);
    // The first turn crossed the connection wait; only a later complete turn is context.
    // Snapshot JA now: KO will complete another turn before JA's first decoded packet.
    speaking.emit("start", ja);
    await startTurn(ko);
    providers[1]?.emit("result", result);
    providers[1]?.emit("endpoint");
    providers[1]?.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 3);
    streams.get(ja)?.write(Buffer.from([0x00]));
    assert.equal(starts.at(-1)?.priorAudio, undefined, "exclude startup-ambiguous and future-ended context");
    speaking.emit("end", ja);
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    primary.emit("result", result);
    primary.emit("endpoint");
    primary.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 4);
    await startTurn(ja);
    assert.equal(starts.at(-1)?.priorAudio?.length, 960);
    primary.emit("result", result);
    primary.emit("endpoint");
    assert.equal(sent.length, 4);
    members.delete(ko);
    await runtime.updateParticipants([ja]);
    primary.emit("finalized");
    providers[1]?.emit("finalized");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 5);
    assert.match(JSON.stringify(sent[4]), /通常の原文/u);
    assert.doesNotMatch(JSON.stringify(sent[4]), /補助認識済み/u);
    assert.ok(closed > 0);
    speaking.emit("start", "523456789012345678");
    assert.equal(providers.length, 2);
    assert.deepEqual(failures, []);
  } finally { await runtime.stop("TEST_COMPLETE"); }
});
