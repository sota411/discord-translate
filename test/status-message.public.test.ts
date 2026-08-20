import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionStatusMessage } from "../src/discord/status-message.js";

void test("現在のセッション状態を利用者向けの全項目入りメッセージへ整形する", () => {
  const message = createSessionStatusMessage({
    sessionId: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "General",
    textChannelId: "text-1",
    textChannelName: "translation",
    startedByUserId: "user-1",
    pair: "ja-ko",
    state: "ACTIVE",
    startedAt: new Date("2026-08-21T02:03:04Z"),
    participantIds: ["user-1", "user-2"],
    playbackMode: "conversation",
    audioEnabled: true,
    captionFailurePolicy: "continue_audio",
    captionThreadId: "thread-1",
  }, ["Sota", "민지"], new Date("2026-08-21T03:05:07Z"));

  assert.equal(message, [
    "**現在の翻訳状態**",
    "状態: 翻訳中",
    "言語ペア: 日本語 ⇄ 韓国語",
    "参加者: Sota / 민지",
    "経過時間: 1:02:03",
    "モード: 会話優先",
    "音声: 有効",
    "字幕スレッド: <#thread-1>",
  ].join("\n"));
});

void test("接続中で字幕スレッド未作成の場合も未確定状態を明示する", () => {
  const message = createSessionStatusMessage({
    sessionId: "session-2",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "General",
    textChannelId: "text-1",
    textChannelName: "translation",
    startedByUserId: "user-1",
    pair: "ja-en",
    state: "CONNECTING",
    startedAt: new Date("2026-08-21T03:05:00Z"),
    participantIds: ["user-1"],
    playbackMode: "accuracy",
    audioEnabled: false,
    captionFailurePolicy: "continue_audio",
  }, ["Sota"], new Date("2026-08-21T03:05:07Z"));

  assert.match(message, /状態: 接続中/u);
  assert.match(message, /経過時間: 00:07/u);
  assert.match(message, /音声: 無効（字幕のみ）/u);
  assert.match(message, /字幕スレッド: 作成中/u);
});
