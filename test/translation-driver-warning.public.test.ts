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
  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public sendAudio(): void {
    return undefined;
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

void test("RuntimeのSTT resultから警告送信失敗をCAPTION_SEND_FAILEDへ渡す", {
  timeout: 2_000,
}, async () => {
  const userId = "323456789012345678";
  const speaking = new EventEmitter();
  const opus = new PassThrough();
  const stt = new FakeSttSession();
  const sent: CaptionMessagePayload[] = [];
  const observedFailure = Promise.withResolvers<{
    guildId: string;
    reason: string;
    publicMessage: string;
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
    },
    participantIds: [userId],
    guild: {
      members: { cache: new Map() },
    },
    voiceChannel: {
      members: new Map([[userId, { user: { bot: false } }]]),
    },
    textChannel: {
      send(payload: CaptionMessagePayload) {
        sent.push(payload);
        return Promise.reject(new Error("Discord unavailable"));
      },
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
    onFailure: (
      guildId: string,
      reason: string,
      publicMessage: string,
      cause?: unknown,
    ) => {
      observedFailure.resolve({ guildId, reason, publicMessage, cause });
    },
  } as unknown as TranslationRuntimeOptions);

  try {
    speaking.emit("start", userId);
    stt.emit("result", unsupportedResult);

    const failure = await observedFailure.promise;
    assert.equal(failure.guildId, "223456789012345678");
    assert.equal(failure.reason, "CAPTION_SEND_FAILED");
    assert.match(failure.publicMessage, /警告を字幕チャンネルへ投稿できません/u);
    assert.equal(sent.length, 1);
    const message = sent[0];
    assert.ok(message);
    assert.equal(message.flags, MessageFlags.IsComponentsV2);
    assert.equal("content" in message, false);
  } finally {
    await runtime.stop("TEST_COMPLETE");
  }
});
