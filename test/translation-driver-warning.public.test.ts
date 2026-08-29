import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { RealtimeResult } from "@soniox/node";
import { MessageFlags } from "discord.js";

import { loadConfig } from "../src/config.js";
import type { CaptionMessagePayload } from "../src/discord/caption-gateway.js";
import {
  DiscordTranslationRuntime,
  type TranslationRuntimeOptions,
} from "../src/discord/translation-driver.js";
import { validEnv } from "./helpers/valid-env.js";

class FakeSttSession extends EventEmitter {
  public audioWrites = 0;

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

void test("RuntimeのSTT resultから警告送信失敗を非致命ログへ渡す", {
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
  let discordUnavailable = true;
  const failures: string[] = [];
  const resolvedUserIds: string[] = [];
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
    config: loadConfig(validEnv({ SONIOX_REGION: "jp" })),
    speakerLanguages: {
      resolve: (_guildId: string, resolvedUserId: string) => {
        resolvedUserIds.push(resolvedUserId);
        return resolvedUserId === userId ? "ko" : undefined;
      },
    },
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
    tts: {},
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
    assert.deepEqual(resolvedUserIds, [userId, replacementUserId]);
    speaking.emit("start", userId);
    assert.deepEqual(sttCreateCalls[0]?.[3], {
      language: "ko",
      strict: false,
    });
    assert.deepEqual(
      resolvedUserIds,
      [userId, replacementUserId],
      "発話開始時に話者言語を再解決しています",
    );
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

    await runtime.updateParticipants([replacementUserId]);
    assert.deepEqual(
      resolvedUserIds,
      [userId, replacementUserId],
      "途中参加時に現在のセッションへ新しい設定を混ぜています",
    );
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

void test("Discord音声受信streamの一時エラーは再購読してセッションを継続する", {
  timeout: 2_000,
}, async () => {
  const userId = "323456789012345678";
  const speaking = new EventEmitter();
  const opusStreams = [new PassThrough(), new PassThrough()];
  const stt = new FakeSttSession();
  const failures: string[] = [];
  const warnings: string[] = [];
  const connectionEvents = new EventEmitter();
  let subscriptions = 0;
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
    config: loadConfig(validEnv({ SONIOX_REGION: "jp" })),
    speakerLanguages: { resolve: () => undefined },
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
    opusStreams[1]?.write(Buffer.from([0x00]));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(stt.audioWrites, 1);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, ["voice_receive_stream_recovering"]);
  } finally {
    await runtime.stop("TEST_COMPLETE");
  }
});
