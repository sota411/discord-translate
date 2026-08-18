import assert from "node:assert/strict";
import { test } from "node:test";

import type { RealtimeResult } from "@soniox/node";
import { ComponentType, MessageFlags } from "discord.js";

import {
  DiscordCaptionGateway,
  type CaptionMessagePayload,
} from "../src/discord/caption-gateway.js";
import { ApplicationError } from "../src/domain/application-error.js";
import { UnsupportedLanguageWarning } from "../src/discord/unsupported-language-warning.js";

type SerializedComponent = {
  type: ComponentType;
  content?: string;
  components?: SerializedComponent[];
};

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

function textContents(payload: CaptionMessagePayload): string[] {
  const visit = (component: SerializedComponent): string[] => [
    ...(component.type === ComponentType.TextDisplay && component.content
      ? [component.content]
      : []),
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return payload.components.flatMap((component) => visit(component.toJSON()));
}

void test("対応ペア外のSTT結果から英語カードをUserごとに1回だけ送る", async () => {
  const sent: CaptionMessagePayload[] = [];
  const failures: string[] = [];
  const warning = new UnsupportedLanguageWarning({
    pair: "ja-ko",
    captions: new DiscordCaptionGateway({
      send(payload: CaptionMessagePayload) {
        sent.push(payload);
        return Promise.resolve({ edit: () => Promise.resolve() });
      },
    }),
    onFailure: (reason) => failures.push(reason),
  });

  await warning.handle("user1", unsupportedResult);
  await warning.handle("user1", unsupportedResult);

  const message = sent[0];
  assert.ok(message);
  assert.equal(sent.length, 1);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.equal("content" in message, false);
  assert.deepEqual(textContents(message), [
    "**⚠ Speech not translated**\n-# Detected language is outside the selected pair.",
  ]);
  assert.deepEqual(failures, []);
});

void test("対応ペア外警告の送信失敗をCAPTION_SEND_FAILEDとして停止経路へ渡す", async () => {
  const failures: {
    reason: string;
    publicMessage: string;
    cause?: unknown;
  }[] = [];
  const warning = new UnsupportedLanguageWarning({
    pair: "ja-ko",
    captions: new DiscordCaptionGateway({
      send() {
        return Promise.reject(new Error("Discord unavailable"));
      },
    }),
    onFailure: (reason, publicMessage, cause) => {
      failures.push({ reason, publicMessage, cause });
    },
  });

  await warning.handle("user1", unsupportedResult);

  const failure = failures[0];
  assert.ok(failure);
  assert.equal(failures.length, 1);
  assert.equal(failure.reason, "CAPTION_SEND_FAILED");
  assert.match(failure.publicMessage, /警告を字幕チャンネルへ投稿できません/u);
  assert.ok(failure.cause instanceof ApplicationError);
  assert.equal(failure.cause.code, "CAPTION_SEND_FAILED");
});
