import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  inlineCode,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import {
  languagePairLabels,
  type LanguagePair,
} from "../domain/language-pair.js";
import {
  captionFailurePolicyLabels,
  captionFailurePolicies,
  type CaptionFailurePolicy,
  playbackModeLabels,
  playbackModes,
  type PlaybackMode,
  formatTtsSpeed,
  ttsSpeedMax,
  ttsSpeedMin,
} from "../session/session-settings.js";
import type {
  CaptionState,
  TranslationUtterance,
} from "../translation/utterance-processor.js";

export type ComponentsMessagePayload = {
  components: [ContainerBuilder];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
};

export type SessionCardView = {
  sessionId: string;
  pair: LanguagePair;
  participantDisplayNames: readonly string[];
  elapsedMs: number;
  queueWaitMs: number;
  queueWarningMs: number;
  playbackMode: PlaybackMode;
  ttsSpeed: number;
  audioEnabled: boolean;
  active: boolean;
  stopReason?: string;
};

export type InterimCaptionView = {
  speakerDisplayName: string;
  originalText: string;
  translatedText: string;
};

const languageCodes: Readonly<Record<Language, string>> = {
  ja: "JA",
  ko: "KO",
  en: "EN",
};

const captionStateLabels: Readonly<Record<CaptionState, string>> = {
  pending: "⏳ 再生待ち",
  played: "🔊 再生済み",
  not_played: "⚠ 音声未再生",
  partial_failure: "⚠ 音声中断",
  skipped_delay: "⏭ 遅延回避のため音声省略",
  interrupted_for_conversation: "⏭ 新しい発話のため音声中断",
  captions_only: "📝 字幕のみ",
};

export function isFinalCaptionStatus(content: string): boolean {
  return Object.entries(captionStateLabels).some(([state, label]) =>
    state !== "pending" && content === `-# ${label}`);
}
const longestCaptionStateLabel = Object.values(captionStateLabels).reduce(
  (longest, candidate) => candidate.length > longest.length ? candidate : longest,
  "",
);

const stopReasonLabels: Readonly<Record<string, string>> = {
  USER_REQUEST: "Stopped by user",
  SPEAKER_NOT_ALLOWED: "Speaker not allowed",
  TOO_MANY_SPEAKERS: "Too many speakers",
  VOICE_EMPTY: "Voice channel is empty",
  USAGE_LIMIT_REACHED: "Usage limit reached",
  USAGE_LEDGER_UNAVAILABLE: "Usage check unavailable",
  USAGE_RECONCILIATION_STALE: "Usage data is out of date",
  BOT_VOICE_REMOVED: "Bot left the voice channel",
  SESSION_TIME_LIMIT: "Session time limit reached",
  SESSION_IDLE: "No speech detected",
  VOICE_CONNECTION_LOST: "Voice connection lost",
  CAPTION_SEND_FAILED: "Caption delivery failed",
  SONIOX_AUTH_FAILED: "Speech service authentication failed",
  SONIOX_BUDGET_EXHAUSTED: "Speech service budget reached",
  SONIOX_LIMIT_EXCEEDED: "Speech service limit reached",
  SONIOX_STREAM_FAILED: "Speech service unavailable",
  TTS_OUTPUT_LIMIT_REACHED: "Generated audio was too long",
  UTTERANCE_TOO_LONG: "Speech segment was too long",
};

function payload(container: ContainerBuilder): ComponentsMessagePayload {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function textDisplay(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

function escapeCaptionMarkdown(content: string): string {
  return escapeMarkdown(content, {
    heading: true,
    bulletedList: true,
    numberedList: true,
    maskedLink: true,
  }).replace(/[<>]/gu, "\\$&");
}

function assertCaptionLength(contents: readonly string[]): void {
  const totalCharacters = contents.reduce(
    (total, content) => total + content.length,
    0,
  );
  if (totalCharacters > 4_000) {
    throw new ApplicationError(
      "CAPTION_SEND_FAILED",
      "字幕がDiscordの4,000文字上限を超えました。",
    );
  }
}

export function createCaptionMessagePayload(
  utterance: TranslationUtterance,
  state: CaptionState,
): ComponentsMessagePayload {
  const source = languageCodes[utterance.sourceLanguage];
  const target = languageCodes[utterance.targetLanguage];
  const header = `**${escapeCaptionMarkdown(utterance.speakerDisplayName)}** · ${inlineCode(`${source} → ${target}`)}`;
  const sourceText = `**${source}**\n${escapeCaptionMarkdown(utterance.originalText)}`;
  const targetText = `**${target}**\n${escapeCaptionMarkdown(utterance.translatedText)}`;
  const status = `-# ${captionStateLabels[state]}`;
  const longestStatus = `-# ${longestCaptionStateLabel}`;
  assertCaptionLength([header, sourceText, targetText, longestStatus]);

  const container = new ContainerBuilder()
    .addTextDisplayComponents(textDisplay(header))
    .addSeparatorComponents(new SeparatorBuilder()
      .setDivider(false)
      .setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(textDisplay(sourceText))
    .addSeparatorComponents(new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(textDisplay(targetText))
    .addTextDisplayComponents(textDisplay(status));
  return payload(container);
}

export function createInterimCaptionMessagePayload(
  interim: InterimCaptionView,
): ComponentsMessagePayload {
  const header = `**${escapeCaptionMarkdown(interim.speakerDisplayName)}**`;
  const lines = [
    interim.originalText.length > 0
      ? `認識中: ${escapeCaptionMarkdown(interim.originalText)}`
      : undefined,
    interim.translatedText.length > 0
      ? `翻訳中: ${escapeCaptionMarkdown(interim.translatedText)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  assertCaptionLength([header, ...lines]);
  return payload(new ContainerBuilder()
    .addTextDisplayComponents(textDisplay(header))
    .addTextDisplayComponents(textDisplay(lines.join("\n"))));
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function createSessionCardMessagePayload(
  view: SessionCardView,
): ComponentsMessagePayload {
  const participantNames = view.participantDisplayNames
    .map((name) => escapeCaptionMarkdown(name))
    .join(" / ");
  const details = [
    languagePairLabels[view.pair],
    `参加者: ${participantNames || "なし"}`,
    `経過時間: ${formatElapsed(view.elapsedMs)}`,
    `現在の音声待ち: ${(view.queueWaitMs / 1_000).toFixed(1)}秒`,
    `モード: ${playbackModeLabels[view.playbackMode]}${view.audioEnabled ? "" : "（字幕のみ）"}`,
    `読み上げ速度: ${formatTtsSpeed(view.ttsSpeed)}`,
  ];
  if (
    view.active &&
    view.playbackMode === "accuracy" &&
    view.queueWaitMs > view.queueWarningMs
  ) {
    details.push(`⚠ 翻訳音声が${(view.queueWaitMs / 1_000).toFixed(1)}秒遅れています`);
  }
  if (!view.active && view.stopReason) {
    details.push(`終了理由: ${view.stopReason}`);
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`translate:${view.sessionId}:stop`)
      .setLabel("停止")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!view.active),
    new ButtonBuilder()
      .setCustomId(`translate:${view.sessionId}:toggle_audio`)
      .setLabel(view.audioEnabled ? "字幕のみへ変更" : "音声へ戻す")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!view.active),
    new ButtonBuilder()
      .setCustomId(`translate:${view.sessionId}:settings`)
      .setLabel("設定")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!view.active),
  );
  const container = new ContainerBuilder()
    .addTextDisplayComponents(textDisplay(view.active ? "**🟢 翻訳中**" : "**⚫ 翻訳終了**"))
    .addTextDisplayComponents(textDisplay(details.join("\n")))
    .addActionRowComponents(buttons);
  return payload(container);
}

export function createSessionSettingsMessagePayload(input: {
  sessionId: string;
  playbackMode: PlaybackMode;
  ttsSpeed: number;
  captionFailurePolicy: CaptionFailurePolicy;
}): ComponentsMessagePayload {
  const playbackSelect = new StringSelectMenuBuilder()
    .setCustomId(`translate:${input.sessionId}:playback_mode`)
    .setPlaceholder("再生モード")
    .addOptions(...playbackModes.map((mode) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(playbackModeLabels[mode])
        .setValue(mode)
        .setDefault(input.playbackMode === mode)));
  const captionFailureSelect = new StringSelectMenuBuilder()
    .setCustomId(`translate:${input.sessionId}:caption_failure_policy`)
    .setPlaceholder("字幕を送れない場合")
    .addOptions(...captionFailurePolicies.map((policy) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(captionFailurePolicyLabels[policy])
        .setValue(policy)
        .setDefault(input.captionFailurePolicy === policy)));
  return payload(new ContainerBuilder()
    .addTextDisplayComponents(textDisplay(
      `**セッション設定**\n読み上げ速度: ${formatTtsSpeed(input.ttsSpeed)}\n-# \`/translate speed rate:1.15\` で${String(ttsSpeedMin)}〜${String(ttsSpeedMax)}倍に変更できます。この翻訳セッションだけに適用されます。`,
    ))
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playbackSelect),
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(captionFailureSelect),
    ));
}

export function createTextCardMessagePayload(markdown: string): ComponentsMessagePayload {
  return payload(new ContainerBuilder().addTextDisplayComponents(textDisplay(markdown)));
}

export function createUnsupportedLanguageMessagePayload(): ComponentsMessagePayload {
  return createTextCardMessagePayload(
    "**⚠ Speech not translated**\n-# Detected language is outside the selected pair.",
  );
}

export function createStopMessagePayload(reason: string): ComponentsMessagePayload {
  const description = stopReasonLabels[reason] ?? "Technical error";
  return createTextCardMessagePayload(
    `**⏹ 翻訳を終了しました**\n-# ${description} · ${inlineCode(reason)}`,
  );
}
