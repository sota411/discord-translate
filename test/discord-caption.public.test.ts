import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DiscordCaptionGateway,
  type CaptionMessagePayload,
} from "../src/discord/caption-gateway.js";

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
    speakerDisplayName: "@everyone sota",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "今日VALORANTやる？",
    translatedText: "오늘 VALORANT 할래?",
    sourceDurationMs: 500,
    state: "pending",
  });
  await captions.update(reference, "played");

  assert.deepEqual(sent[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(edited[0]?.allowedMentions, { parse: [] });
  assert.match(sent[0].content, /音声: 再生待ち/u);
  assert.match(edited[0].content, /音声: 再生済み/u);
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
});
