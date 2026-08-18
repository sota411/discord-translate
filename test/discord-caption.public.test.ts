import assert from "node:assert/strict";
import { test } from "node:test";

import { ComponentType, MessageFlags } from "discord.js";

import {
  DiscordCaptionGateway,
  type CaptionMessagePayload,
} from "../src/discord/caption-gateway.js";
import { ApplicationError } from "../src/domain/application-error.js";

type SerializedComponent = {
  type: ComponentType;
  content?: string;
  components?: SerializedComponent[];
};

function textContents(payload: CaptionMessagePayload): string[] {
  const components = (payload as unknown as {
    components?: { toJSON(): SerializedComponent }[];
  }).components ?? [];
  const visit = (component: SerializedComponent): string[] => [
    ...(component.type === ComponentType.TextDisplay && component.content
      ? [component.content]
      : []),
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return components.flatMap((component) => visit(component.toJSON()));
}

void test("字幕の作成と編集の両方でmentionを無効化し、同じメッセージだけを更新する", async () => {
  const sent: CaptionMessagePayload[] = [];
  const edited: CaptionMessagePayload[] = [];
  const channel = {
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({
        edit(next: CaptionMessagePayload) {
          edited.push(next);
          return Promise.resolve();
        },
      });
    },
  };
  const captions = new DiscordCaptionGateway(channel);

  const reference = await captions.post({
    utteranceId: "u1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "@everyone **sota**",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "**今日**VALORANTやる？",
    translatedText: "오늘 VALORANT 할래?",
    sourceDurationMs: 500,
    state: "pending",
  });
  await captions.update(reference, "played");

  assert.deepEqual(sent[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(edited[0]?.allowedMentions, { parse: [] });
  assert.equal(
    (sent[0] as unknown as { flags?: number }).flags,
    MessageFlags.IsComponentsV2,
  );
  assert.equal(
    (edited[0] as unknown as { flags?: number }).flags,
    MessageFlags.IsComponentsV2,
  );
  assert.equal("content" in sent[0], false);
  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(textContents(message), [
    "**@everyone \\*\\*sota\\*\\*** · `JA → KO`",
    "**JA**\n\\*\\*今日\\*\\*VALORANTやる？",
    "**KO**\n오늘 VALORANT 할래?",
    "-# ⏳ QUEUED",
  ]);
  assert.deepEqual(textContents(edited[0]), [
    "**@everyone \\*\\*sota\\*\\*** · `JA → KO`",
    "**JA**\n\\*\\*今日\\*\\*VALORANTやる？",
    "**KO**\n오늘 VALORANT 할래?",
    "-# 🔊 PLAYED",
  ]);
  assert.doesNotMatch(JSON.stringify(sent[0]), /日本語|韓国語|原文|翻訳|再生/u);
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
});

void test("字幕の未再生と中断状態を短い言語非依存ラベルで表示する", async () => {
  const states = [
    ["not_played", "-# ⚠ NOT PLAYED"],
    ["partial_failure", "-# ⚠ INTERRUPTED"],
  ] as const;

  for (const [state, expected] of states) {
    const sent: CaptionMessagePayload[] = [];
    const captions = new DiscordCaptionGateway({
      send(payload: CaptionMessagePayload) {
        sent.push(payload);
        return Promise.resolve({ edit: () => Promise.resolve() });
      },
    });

    await captions.post({
      utteranceId: `u-${state}`,
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
      sourceLanguage: "en",
      targetLanguage: "ja",
      originalText: "hello",
      translatedText: "こんにちは",
      sourceDurationMs: 500,
      state,
    });

    const message = sent[0];
    assert.ok(message);
    assert.equal(textContents(message).at(-1), expected);
  }
});

void test("字幕本文をDiscord Markdownとして解釈させず文字列のまま表示する", async () => {
  const sent: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({ edit: () => Promise.resolve() });
    },
  });

  await captions.post({
    utteranceId: "u-markdown",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "# speaker",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "# heading\n- item\n1. item\n> quote\n[label](https://example.com)\n<https://example.com>\n<@123456789012345678>\n<t:0:R>",
    translatedText: "**bold**",
    sourceDurationMs: 500,
    state: "pending",
  });

  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(textContents(message), [
    "**\\# speaker** · `JA → KO`",
    "**JA**\n\\# heading\n\\- item\n1\\. item\n\\> quote\n\\[label](https://example.com)\n\\<https://example.com\\>\n\\<@123456789012345678\\>\n\\<t:0:R\\>",
    "**KO**\n\\*\\*bold\\*\\*",
    "-# ⏳ QUEUED",
  ]);
});

void test("対応ペア外の発話警告も英語のComponents V2カードとして送る", async () => {
  const sent: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({ edit: () => Promise.resolve() });
    },
  });

  await captions.postUnsupportedLanguageWarning();

  const message = sent[0];
  assert.ok(message);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in message, false);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.deepEqual(textContents(message), [
    "**⚠ Speech not translated**\n-# Detected language is outside the selected pair.",
  ]);
});

void test("字幕カード全体のText Display上限を超える場合は送信前に失敗する", async () => {
  let sent = false;
  const captions = new DiscordCaptionGateway({
    send() {
      sent = true;
      return Promise.resolve({ edit: () => Promise.resolve() });
    },
  });

  await assert.rejects(
    captions.post({
      utteranceId: "u-too-long",
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: "あ".repeat(2_000),
      translatedText: "가".repeat(2_000),
      sourceDurationMs: 500,
      state: "pending",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "CAPTION_SEND_FAILED" &&
      error.publicMessage.includes("4,000文字"),
  );
  assert.equal(sent, false);
});

void test("QUEUEDが上限内でも後続の最長状態へ更新できない字幕は初回送信前に失敗する", async () => {
  let sent = false;
  const captions = new DiscordCaptionGateway({
    send() {
      sent = true;
      return Promise.resolve({ edit: () => Promise.resolve() });
    },
  });

  await assert.rejects(
    captions.post({
      utteranceId: "u-status-reserve",
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: "あ".repeat(3_952),
      translatedText: "가",
      sourceDurationMs: 500,
      state: "pending",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "CAPTION_SEND_FAILED",
  );
  assert.equal(sent, false);
});
