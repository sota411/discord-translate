import {
  ContainerBuilder,
  escapeMarkdown,
  inlineCode,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";

import { ApplicationError } from "../domain/application-error.js";
import type { Language } from "../domain/language-pair.js";
import type {
  CaptionState,
  TranslationUtterance,
} from "../translation/utterance-processor.js";

export type ComponentsMessagePayload = {
  components: [ContainerBuilder];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
};

const languageCodes: Readonly<Record<Language, string>> = {
  ja: "JA",
  ko: "KO",
  en: "EN",
};

const captionStateLabels: Readonly<Record<CaptionState, string>> = {
  pending: "⏳ QUEUED",
  played: "🔊 PLAYED",
  not_played: "⚠ NOT PLAYED",
  partial_failure: "⚠ INTERRUPTED",
};
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
  PLAYBACK_BACKLOG: "Audio queue limit reached",
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
      "字幕がDiscordの4,000文字上限を超えたため、翻訳を停止します。",
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
    `**⚠ Translation stopped**\n-# ${description} · ${inlineCode(reason)}`,
  );
}
