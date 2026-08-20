import { escapeMarkdown } from "discord.js";

import { languagePairLabels } from "../domain/language-pair.js";
import type {
  SessionDescriptor,
  SessionState,
} from "../session/session-manager.js";
import { playbackModeLabels } from "../session/session-settings.js";

const sessionStateLabels: Readonly<Record<SessionState, string>> = {
  AUTHORIZING: "利用条件を確認中",
  CONNECTING: "接続中",
  ACTIVE: "翻訳中",
  FAILED: "失敗",
  STOPPING: "停止中",
};

export function createSessionStatusMessage(
  session: Readonly<SessionDescriptor>,
  participantDisplayNames: readonly string[],
  now: Date,
): string {
  const elapsedMs = Math.max(0, now.getTime() - session.startedAt.getTime());
  const participants = participantDisplayNames
    .map((name) => escapeMarkdown(name))
    .join(" / ");
  return [
    "**現在の翻訳状態**",
    `状態: ${sessionStateLabels[session.state]}`,
    `言語ペア: ${languagePairLabels[session.pair]}`,
    `参加者: ${participants || "なし"}`,
    `経過時間: ${formatElapsed(elapsedMs)}`,
    `モード: ${playbackModeLabels[session.playbackMode]}`,
    `音声: ${session.audioEnabled ? "有効" : "無効（字幕のみ）"}`,
    `字幕スレッド: ${session.captionThreadId ? `<#${session.captionThreadId}>` : "作成中"}`,
  ].join("\n");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
