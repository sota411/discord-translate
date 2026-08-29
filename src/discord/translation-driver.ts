import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import opus from "@discordjs/opus";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  type Client,
  type Guild,
  type VoiceChannel,
} from "discord.js";
import {
  AuthError,
  QuotaError,
  type RealtimeResult,
  type RealtimeSttSession,
} from "@soniox/node";

import type { AppConfig } from "../config.js";
import type { SpeakerLanguageSettings } from "../config/speaker-language-settings.js";
import type { TranslationTerm } from "../config/translation-terms.js";
import { decodeDiscordOpusPacketToMono } from "../audio/pcm.js";
import { OpusStartupBuffer } from "../audio/opus-startup-buffer.js";
import {
  SttTurnFinalizer,
  type SttBoundaryKind,
} from "../audio/stt-turn-finalizer.js";
import { ApplicationError } from "../domain/application-error.js";
import {
  languagesForPair,
  type Language,
} from "../domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";
import {
  createTranslationQualityObservation,
  type TranslationQualityObservation,
} from "../observability/translation-quality.js";
import {
  sttFinalizeFlowStage,
  type TranslationFlowObserver,
} from "../observability/translation-flow.js";
import type {
  SessionDescriptor,
  SessionRuntime,
  TranslationSessionDriver,
} from "../session/session-manager.js";
import { SpeakerVoiceAssignments } from "../session/speaker-voice-assignments.js";
import { conversationAudioMaxDelayMs } from "../session/session-settings.js";
import { SonioxSttFactory } from "../soniox/control.js";
import type { TtsGateway } from "../translation/utterance-processor.js";
import { StreamingUtterance } from "../translation/streaming-utterance.js";
import type { InterimUtterance } from "../translation/token-assembler.js";
import { UtteranceProcessor } from "../translation/utterance-processor.js";
import type { UsageLedger } from "../usage/usage-ledger.js";
import {
  DiscordCaptionGateway,
  type CaptionDeliveryObservation,
} from "./caption-gateway.js";
import { DiscordPlaybackGateway } from "./playback-gateway.js";
import { DiscordSessionPresentation } from "./session-presentation.js";
import { UnsupportedLanguageWarning } from "./unsupported-language-warning.js";

const { OpusEncoder } = opus;
const maxStartupOpusPackets = 250;
const maxStartupOpusBytes = 512 * 1024;
const speakingEndFinalizeDelayMs = 100;
const transcriptInactivityFinalizeMs = 3_000;
const manualFinalizeTrailingSilenceMs = 200;
const interimCaptionThrottleMs = 500;
const voiceReceiveRecoveryDelayMs = 200;
const maxConsecutiveVoiceReceiveRecoveries = 3;

export type RuntimeFailureHandler = (
  guildId: string,
  reason: string,
  publicMessage: string,
  cause?: unknown,
) => void;

type DiscordTranslationDriverOptions = {
  client: Client;
  config: AppConfig;
  speakerLanguages: Pick<SpeakerLanguageSettings, "resolve">;
  ledger: UsageLedger;
  sttFactory: SonioxSttFactory;
  tts: TtsGateway;
  latency: TranslationLatencyRecorder;
  observeFlow?: TranslationFlowObserver;
  observeQuality?: (observation: TranslationQualityObservation) => void;
  observeCaptionDelivery?: (observation: CaptionDeliveryObservation) => void;
  observeSttResult?: () => void;
  onFailure: RuntimeFailureHandler;
  onWarning?: (guildId: string, operation: string, cause: unknown) => void;
};

type SpeakerStream = {
  userId: string;
  requestRef: string;
  opus: AudioReceiveStream;
  decoder: InstanceType<typeof OpusEncoder>;
  stt: RealtimeSttSession;
  turnFinalizer: SttTurnFinalizer;
  utterance: StreamingUtterance;
  turnId: string;
  pendingPreview?: InterimUtterance;
  previewTimer?: NodeJS.Timeout;
  lastPreviewAtMonotonic: number;
  burstHasPacket: boolean;
  lastUsageAtMonotonic?: number;
  lastAudioAtMonotonic?: number;
  pendingTextCharacters: number;
  startupOpus: OpusStartupBuffer;
  sttConnected: boolean;
  startupBufferOverflowed: boolean;
  keepaliveTimer?: NodeJS.Timeout;
  usageTimer?: NodeJS.Timeout;
  receiveRecoveryTimer?: NodeJS.Timeout;
  receiveRecoveryAttempts: number;
  lastTranscriptFingerprint?: string;
  closed: boolean;
};

function transcriptFingerprint(result: RealtimeResult): string | undefined {
  const tokens = result.tokens.filter((token) => token.text.trim().length > 0);
  if (tokens.length === 0) return undefined;
  return JSON.stringify(tokens.map((token) => [
    token.text,
    token.is_final,
    token.start_ms,
    token.end_ms,
    token.language,
    token.source_language,
    token.translation_status,
  ]));
}

function mapSttError(error: unknown): ApplicationError {
  if (error instanceof AuthError) {
    return new ApplicationError(
      "SONIOX_AUTH_FAILED",
      "Sonioxの認証に失敗しました。運営者へ連絡してください。",
      { cause: error },
    );
  }
  if (error instanceof QuotaError) {
    const code = error.statusCode === 402
      ? "SONIOX_BUDGET_EXHAUSTED"
      : "SONIOX_LIMIT_EXCEEDED";
    return new ApplicationError(
      code,
      error.statusCode === 402
        ? "Sonioxの残高または月額上限へ達しました。"
        : "Sonioxの同時実行上限へ達しました。",
      { cause: error },
    );
  }
  return error instanceof ApplicationError
    ? error
    : new ApplicationError(
        "SONIOX_STREAM_FAILED",
        "Sonioxの音声認識ストリームに失敗しました。",
        { cause: error },
      );
}

function speakerLanguageHint(
  language: Language | undefined,
  pair: SessionDescriptor["pair"],
): { language: ReturnType<typeof languagesForPair>[number]; strict: false } | undefined {
  if (language === undefined || !languagesForPair(pair).includes(language)) return undefined;
  return { language, strict: false };
}

export class DiscordTranslationDriver implements TranslationSessionDriver {
  readonly #client: Client;
  readonly #config: AppConfig;
  readonly #speakerLanguages: Pick<SpeakerLanguageSettings, "resolve">;
  readonly #ledger: UsageLedger;
  readonly #sttFactory: SonioxSttFactory;
  readonly #tts: TtsGateway;
  readonly #latency: TranslationLatencyRecorder;
  readonly #observeFlow: TranslationFlowObserver;
  readonly #observeQuality: (observation: TranslationQualityObservation) => void;
  readonly #observeCaptionDelivery: (observation: CaptionDeliveryObservation) => void;
  readonly #observeSttResult: () => void;
  readonly #onFailure: RuntimeFailureHandler;
  readonly #onWarning: (guildId: string, operation: string, cause: unknown) => void;

  public constructor(options: DiscordTranslationDriverOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#speakerLanguages = options.speakerLanguages;
    this.#ledger = options.ledger;
    this.#sttFactory = options.sttFactory;
    this.#tts = options.tts;
    this.#latency = options.latency;
    this.#observeFlow = options.observeFlow ?? (() => undefined);
    this.#observeQuality = options.observeQuality ?? (() => undefined);
    this.#observeCaptionDelivery = options.observeCaptionDelivery ?? (() => undefined);
    this.#observeSttResult = options.observeSttResult ?? (() => undefined);
    this.#onFailure = (guildId, reason, publicMessage, cause) => {
      options.onFailure(guildId, reason, publicMessage, cause);
    };
    this.#onWarning = options.onWarning ?? (() => undefined);
  }

  public async start(
    session: Readonly<SessionDescriptor>,
    participantIds: readonly string[],
    signal: AbortSignal,
    translationTerms: readonly TranslationTerm[],
  ): Promise<SessionRuntime> {
    signal.throwIfAborted();
    const guild = this.#client.guilds.cache.get(session.guildId);
    if (!guild) throw new Error("Discord Guildがクライアントキャッシュにありません");
    const [voiceChannel, textChannel] = await Promise.all([
      guild.channels.fetch(session.voiceChannelId),
      guild.channels.fetch(session.textChannelId),
    ]);
    signal.throwIfAborted();
    if (voiceChannel?.type !== ChannelType.GuildVoice) {
      throw new Error("対象チャンネルはGuild Voice Channelではありません");
    }
    if (textChannel?.type !== ChannelType.GuildText) {
      throw new Error("セッションカードの親はGuild Text Channelではありません");
    }
    this.#assertParticipantsUnchanged(voiceChannel, participantIds);

    this.#ledger.createSession({
      sessionId: session.sessionId,
      guildId: session.guildId,
      voiceChannelId: session.voiceChannelId,
      textChannelId: session.textChannelId,
      startedByUserId: session.startedByUserId,
      pair: session.pair,
      startedAt: session.startedAt,
    });

    let connection: VoiceConnection | undefined;
    let presentation: DiscordSessionPresentation | undefined;
    try {
      signal.throwIfAborted();
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      );
      signal.throwIfAborted();
      this.#assertParticipantsUnchanged(voiceChannel, participantIds);
      presentation = await DiscordSessionPresentation.open({
        channel: textChannel,
        sessionId: session.sessionId,
        pair: session.pair,
        participantDisplayNames: this.#participantDisplayNames(guild, participantIds),
        playbackMode: session.playbackMode,
        ttsSpeed: session.ttsSpeed,
        audioEnabled: session.audioEnabled,
        queueWarningMs: conversationAudioMaxDelayMs,
        startedAt: session.startedAt,
        onWarning: (operation, cause) => {
          this.#onWarning(session.guildId, operation, cause);
        },
      });
      signal.throwIfAborted();
      return new DiscordTranslationRuntime({
        session,
        participantIds,
        guild,
        voiceChannel,
        presentation,
        connection,
        config: this.#config,
        speakerLanguages: this.#speakerLanguages,
        ledger: this.#ledger,
        sttFactory: this.#sttFactory,
        translationTerms,
        tts: this.#tts,
        latency: this.#latency,
        observeFlow: this.#observeFlow,
        observeQuality: this.#observeQuality,
        observeCaptionDelivery: this.#observeCaptionDelivery,
        observeSttResult: this.#observeSttResult,
        onFailure: this.#onFailure,
        onWarning: this.#onWarning,
      });
    } catch (error) {
      await presentation?.close("START_ABORTED");
      connection?.destroy();
      this.#ledger.finishSession(session.sessionId, "START_FAILED", new Date());
      throw error;
    }
  }

  #participantDisplayNames(guild: Guild, participantIds: readonly string[]): string[] {
    return participantIds.map((userId) =>
      guild.members.cache.get(userId)?.displayName ?? "参加者");
  }

  #assertParticipantsUnchanged(
    voiceChannel: VoiceChannel,
    participantIds: readonly string[],
  ): void {
    const current = [...voiceChannel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => member.id)
      .sort();
    const authorized = [...participantIds].sort();
    if (
      current.length !== authorized.length ||
      current.some((userId, index) => userId !== authorized[index])
    ) {
      throw new ApplicationError(
        "SESSION_START_FAILED",
        "開始処理中に音声チャンネルの参加者が変わりました。もう一度実行してください。",
      );
    }
  }
}

export type TranslationRuntimeOptions = {
  session: Readonly<SessionDescriptor>;
  participantIds: readonly string[];
  guild: Guild;
  voiceChannel: VoiceChannel;
  presentation: DiscordSessionPresentation;
  connection: VoiceConnection;
  config: AppConfig;
  speakerLanguages: Pick<SpeakerLanguageSettings, "resolve">;
  ledger: UsageLedger;
  sttFactory: SonioxSttFactory;
  translationTerms: readonly TranslationTerm[];
  tts: TtsGateway;
  latency: TranslationLatencyRecorder;
  observeFlow: TranslationFlowObserver;
  observeQuality?: (observation: TranslationQualityObservation) => void;
  observeCaptionDelivery: (observation: CaptionDeliveryObservation) => void;
  observeSttResult?: () => void;
  onFailure: RuntimeFailureHandler;
  onWarning: (guildId: string, operation: string, cause: unknown) => void;
};

export class DiscordTranslationRuntime implements SessionRuntime {
  public readonly captionThreadId: string;
  readonly #session: Readonly<SessionDescriptor>;
  readonly #guild: Guild;
  readonly #voiceChannel: VoiceChannel;
  readonly #captions: DiscordCaptionGateway;
  readonly #presentation: DiscordSessionPresentation;
  readonly #connection: VoiceConnection;
  readonly #config: AppConfig;
  readonly #speakerLanguageHints = new Map<string, Language>();
  readonly #ledger: UsageLedger;
  readonly #sttFactory: SonioxSttFactory;
  readonly #translationTerms: readonly TranslationTerm[];
  readonly #tts: TtsGateway;
  readonly #latency: TranslationLatencyRecorder;
  readonly #observeFlow: TranslationFlowObserver;
  readonly #observeQuality: (observation: TranslationQualityObservation) => void;
  readonly #observeSttResult: () => void;
  readonly #onFailure: RuntimeFailureHandler;
  readonly #onWarning: (guildId: string, operation: string, cause: unknown) => void;
  readonly #player: AudioPlayer;
  readonly #processor: UtteranceProcessor;
  readonly #unsupportedLanguageWarning: UnsupportedLanguageWarning;
  readonly #participants: Set<string>;
  readonly #voiceAssignments: SpeakerVoiceAssignments;
  readonly #speakers = new Map<string, SpeakerStream>();
  readonly #speakingListener: (userId: string) => void;
  readonly #speakingEndListener: (userId: string) => void;
  readonly #maxSessionTimer: NodeJS.Timeout;
  readonly #idleTimer: NodeJS.Timeout;
  readonly #presentationTimer: NodeJS.Timeout;
  #accuracyDelayWarning: { queueWaitMs: number; expiresAt: number } | undefined;
  #lastHumanAudioAt = performance.now();
  #stopping = false;
  #failureSent = false;

  public constructor(options: TranslationRuntimeOptions) {
    this.captionThreadId = options.presentation.threadId;
    this.#session = options.session;
    for (const allowedUserId of options.config.discord.allowedUserIds) {
      const language = options.speakerLanguages.resolve(
        options.session.guildId,
        allowedUserId,
        options.session.pair,
      );
      if (language !== undefined) this.#speakerLanguageHints.set(allowedUserId, language);
    }
    this.#guild = options.guild;
    this.#voiceChannel = options.voiceChannel;
    this.#presentation = options.presentation;
    this.#onWarning = options.onWarning;
    this.#captions = new DiscordCaptionGateway(options.presentation.captionChannel, {
      failurePolicy: options.session.captionFailurePolicy,
      onWarning: (operation, cause) => {
        this.#onWarning(options.session.guildId, operation, cause);
      },
      onClosedOperationSettled: () => {
        this.#presentation.rearchiveAfterClose();
      },
      observeDelivery: options.observeCaptionDelivery,
    });
    this.#connection = options.connection;
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#sttFactory = options.sttFactory;
    this.#translationTerms = options.translationTerms.map((term) => ({ ...term }));
    this.#tts = options.tts;
    this.#latency = options.latency;
    this.#observeFlow = options.observeFlow;
    this.#observeQuality = options.observeQuality ?? (() => undefined);
    this.#observeSttResult = options.observeSttResult ?? (() => undefined);
    this.#onFailure = (guildId, reason, publicMessage, cause) => {
      options.onFailure(guildId, reason, publicMessage, cause);
    };
    this.#participants = new Set(options.participantIds);
    this.#voiceAssignments = new SpeakerVoiceAssignments([
      options.config.soniox.voices.ja,
      options.config.soniox.voices.ko,
      options.config.soniox.voices.en,
    ]);
    this.#voiceAssignments.updateParticipants(options.participantIds);
    this.#player = createAudioPlayer();
    this.#connection.subscribe(this.#player);
    const playback = new DiscordPlaybackGateway(this.#player, options.latency);
    this.#processor = new UtteranceProcessor({
      captions: this.#captions,
      playback,
      tts: options.tts,
      maxQueueWaitMs: options.config.limits.playbackQueueMaxMs,
      playbackMode: options.session.playbackMode,
      ttsSpeed: options.session.ttsSpeed,
      maxSourceDurationMs: options.config.limits.utteranceMaxSourceSeconds * 1000,
      maxInputCharacters: options.config.limits.ttsMaxInputCharacters,
      latency: options.latency,
      onQueueDelay: (queueWaitMs) => {
        this.#accuracyDelayWarning = {
          queueWaitMs,
          expiresAt: performance.now() + 5_000,
        };
        void this.#refreshPresentation({ queueWaitMs }).catch((error: unknown) => {
          this.#onWarning(this.#session.guildId, "card_update", error);
        });
      },
      onFatal: (error) => this.#fail(error.code, error.publicMessage),
    });
    this.#unsupportedLanguageWarning = new UnsupportedLanguageWarning({
      pair: options.session.pair,
      captions: this.#captions,
      onFailure: (reason, publicMessage, cause) => {
        this.#fail(reason, publicMessage, cause);
      },
    });

    this.#speakingListener = (userId) => this.#handleSpeakingStart(userId);
    this.#speakingEndListener = (userId) => this.#handleSpeakingEnd(userId);
    this.#connection.receiver.speaking.on("start", this.#speakingListener);
    this.#connection.receiver.speaking.on("end", this.#speakingEndListener);
    this.#connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.#recoverVoiceConnection();
    });
    this.#player.on("error", (error) => {
      this.#fail("VOICE_CONNECTION_LOST", "Discordで翻訳音声を再生できませんでした。", error);
    });

    this.#maxSessionTimer = setTimeout(() => {
      this.#fail("SESSION_TIME_LIMIT", "セッション時間の上限へ達したため翻訳を停止します。");
    }, options.config.limits.sessionMaxMinutes * 60_000);
    this.#maxSessionTimer.unref();
    this.#idleTimer = setInterval(() => {
      const idleMs = performance.now() - this.#lastHumanAudioAt;
      if (idleMs >= options.config.limits.sessionIdleTimeoutSeconds * 1000) {
        this.#fail("SESSION_IDLE", "無音時間の上限へ達したため翻訳を停止します。");
      }
    }, Math.min(1_000, options.config.limits.sessionIdleTimeoutSeconds * 1000));
    this.#idleTimer.unref();
    this.#presentationTimer = setInterval(() => {
      void this.#refreshPresentation();
    }, 5_000);
    this.#presentationTimer.unref();
  }

  public async updateParticipants(participantIds: readonly string[]): Promise<void> {
    const next = new Set(participantIds);
    const removed = [...this.#speakers.keys()].filter((userId) => !next.has(userId));
    this.#participants.clear();
    for (const participantId of participantIds) this.#participants.add(participantId);
    const cleanupResults = await Promise.allSettled(
      removed.map((userId) => Promise.resolve().then(() => {
        this.#closeSpeaker(userId, "completed");
      })),
    );
    const cleanupErrors: unknown[] = [];
    for (const result of cleanupResults) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "退出した発話者の音声ストリームを正常に終了できませんでした",
      );
    }
    this.#voiceAssignments.updateParticipants(participantIds);
    await this.#refreshPresentation();
  }

  public async setPlaybackMode(mode: import("../session/session-settings.js").PlaybackMode): Promise<void> {
    if (mode !== "accuracy") this.#accuracyDelayWarning = undefined;
    this.#processor.setPlaybackMode(mode);
    await this.#refreshPresentation({ playbackMode: mode });
  }

  public async setTtsSpeed(speed: number): Promise<void> {
    this.#processor.setTtsSpeed(speed);
    await this.#refreshPresentation({ ttsSpeed: speed });
  }

  public async setAudioEnabled(enabled: boolean): Promise<void> {
    if (!enabled) this.#accuracyDelayWarning = undefined;
    this.#processor.setAudioEnabled(enabled);
    await this.#refreshPresentation({ audioEnabled: enabled });
  }

  public setCaptionFailurePolicy(
    policy: import("../session/session-settings.js").CaptionFailurePolicy,
  ): Promise<void> {
    this.#captions.setFailurePolicy(policy);
    return Promise.resolve();
  }

  public async stop(reason: string): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const cleanupErrors: unknown[] = [];
    clearTimeout(this.#maxSessionTimer);
    clearInterval(this.#idleTimer);
    clearInterval(this.#presentationTimer);
    this.#connection.receiver.speaking.off("start", this.#speakingListener);
    this.#connection.receiver.speaking.off("end", this.#speakingEndListener);
    try {
      await this.#processor.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const providerStatus = reason.startsWith("SONIOX_") ? "failed" : "completed";
    for (const userId of [...this.#speakers.keys()]) {
      try {
        this.#closeSpeaker(userId, providerStatus);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      this.#player.stop(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.#connection.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.#ledger.finishSession(this.#session.sessionId, reason, new Date());
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.#captions.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    await this.#presentation.close(reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "翻訳セッションの停止処理に失敗しました");
    }
  }

  #handleSpeakingStart(userId: string): void {
    if (
      this.#stopping ||
      !this.#participants.has(userId) ||
      !this.#config.discord.allowedUserIds.has(userId)
    ) {
      return;
    }
    const member = this.#voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    this.#processor.interruptForNewSpeech();
    this.#observeFlow("voice_speaking_started");
    this.#tts.warm?.();
    const existing = this.#speakers.get(userId);
    if (existing) {
      existing.turnFinalizer.speakingStarted();
      existing.burstHasPacket = false;
      return;
    }

    const opus = this.#connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const requestRef = randomUUID();
    const languageHint = speakerLanguageHint(
      this.#speakerLanguageHints.get(userId),
      this.#session.pair,
    );
    const stt = this.#sttFactory.create(
      this.#session.pair,
      requestRef,
      this.#translationTerms,
      languageHint,
    );
    const turnFinalizer = new SttTurnFinalizer({
      session: stt.session,
      speakingEndDelayMs: speakingEndFinalizeDelayMs,
      transcriptInactivityMs: transcriptInactivityFinalizeMs,
      maxTurnMs: this.#config.limits.utteranceMaxSourceSeconds * 1_000,
      trailingSilenceMs: manualFinalizeTrailingSilenceMs,
      onFinalize: (reason) => {
        this.#observeFlow(sttFinalizeFlowStage(reason));
      },
      onError: (error) => {
        const mapped = mapSttError(error);
        this.#fail(mapped.code, mapped.publicMessage, error);
      },
    });
    turnFinalizer.speakingStarted();
    const speaker: SpeakerStream = {
      userId,
      requestRef,
      opus,
      decoder: new OpusEncoder(48_000, 2),
      stt: stt.session,
      turnFinalizer,
      utterance: new StreamingUtterance({
        pair: this.#session.pair,
        maxSourceDurationMs: this.#config.limits.utteranceMaxSourceSeconds * 1_000,
        maxInputCharacters: this.#config.limits.ttsMaxInputCharacters,
      }),
      turnId: randomUUID(),
      lastPreviewAtMonotonic: Number.NEGATIVE_INFINITY,
      burstHasPacket: false,
      pendingTextCharacters: stt.initialTextCharacterCount,
      startupOpus: new OpusStartupBuffer({
        maxPackets: maxStartupOpusPackets,
        maxBytes: maxStartupOpusBytes,
      }),
      sttConnected: false,
      startupBufferOverflowed: false,
      receiveRecoveryAttempts: 0,
      closed: false,
    };
    this.#speakers.set(userId, speaker);
    this.#attachSpeakerAudio(speaker, opus);
    void this.#connectSpeaker(speaker).catch((error: unknown) => {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    });
  }

  #attachSpeakerAudio(speaker: SpeakerStream, stream: AudioReceiveStream): void {
    speaker.opus = stream;
    let streamError: unknown;
    stream.on("data", (packet: Buffer) => {
      if (speaker.closed || speaker.opus !== stream) return;
      speaker.receiveRecoveryAttempts = 0;
      this.#handleOpusPacket(speaker, packet);
    });
    stream.once("error", (error) => {
      streamError = error;
    });
    stream.once("close", () => {
      if (this.#stopping || speaker.closed || speaker.opus !== stream) return;
      this.#recoverSpeakerAudio(
        speaker,
        stream,
        streamError ?? new Error("Discordの音声受信streamが予期せず終了しました。"),
      );
    });
  }

  #recoverSpeakerAudio(
    speaker: SpeakerStream,
    closedStream: AudioReceiveStream,
    cause: unknown,
  ): void {
    speaker.receiveRecoveryAttempts += 1;
    if (speaker.receiveRecoveryAttempts > maxConsecutiveVoiceReceiveRecoveries) {
      this.#fail("VOICE_CONNECTION_LOST", "Discordの音声受信を復旧できませんでした。", cause);
      return;
    }
    this.#onWarning(this.#session.guildId, "voice_receive_stream_recovering", cause);
    const timer = setTimeout(() => {
      if (speaker.receiveRecoveryTimer === timer) delete speaker.receiveRecoveryTimer;
      if (this.#stopping || speaker.closed || speaker.opus !== closedStream) return;
      try {
        const nextStream = this.#connection.receiver.subscribe(speaker.userId, {
          end: { behavior: EndBehaviorType.Manual },
        });
        this.#attachSpeakerAudio(speaker, nextStream);
      } catch (error) {
        this.#fail("VOICE_CONNECTION_LOST", "Discordの音声受信を再開できませんでした。", error);
      }
    }, voiceReceiveRecoveryDelayMs);
    speaker.receiveRecoveryTimer = timer;
    timer.unref();
  }

  async #connectSpeaker(speaker: SpeakerStream): Promise<void> {
    this.#ledger.openProviderRequest({
      requestRef: speaker.requestRef,
      sessionId: this.#session.sessionId,
      userId: speaker.userId,
      kind: "stt",
      startedAt: new Date(),
    });
    speaker.stt.on("result", (result) => this.#handleSttResult(speaker, result));
    speaker.stt.on("endpoint", () => {
      this.#handleSttBoundary(speaker, "endpoint");
    });
    speaker.stt.on("finalized", () => {
      this.#handleSttBoundary(speaker, "finalized");
    });
    speaker.stt.on("error", (error) => {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    });
    await speaker.stt.connect();
    if (this.#stopping || speaker.closed || speaker.startupBufferOverflowed) {
      speaker.stt.close();
      return;
    }

    speaker.lastUsageAtMonotonic = performance.now();
    speaker.sttConnected = true;
    for (const packet of speaker.startupOpus.drain()) {
      this.#handleOpusPacket(speaker, packet);
    }
    speaker.keepaliveTimer = setInterval(() => {
      if (!speaker.closed) {
        try {
          speaker.stt.keepAlive();
        } catch (error) {
          this.#fail("SONIOX_STREAM_FAILED", "Soniox STTのkeepaliveに失敗しました。", error);
        }
      }
    }, 10_000);
    speaker.keepaliveTimer.unref();
    speaker.usageTimer = setInterval(() => {
      try {
        this.#flushSpeakerUsage(speaker);
      } catch (error) {
        const mapped = mapSttError(error);
        this.#fail(mapped.code, mapped.publicMessage, error);
      }
    }, 30_000);
    speaker.usageTimer.unref();
  }

  #handleOpusPacket(speaker: SpeakerStream, packet: Buffer): void {
    try {
      if (
        this.#stopping ||
        speaker.closed ||
        speaker.startupBufferOverflowed ||
        !this.#participants.has(speaker.userId) ||
        !this.#config.discord.allowedUserIds.has(speaker.userId)
      ) {
        return;
      }
      if (!speaker.sttConnected) {
        if (!speaker.startupOpus.enqueue(packet)) {
          speaker.startupBufferOverflowed = true;
          speaker.startupOpus.clear();
          this.#observeFlow("voice_startup_buffer_overflow");
          this.#fail(
            "SONIOX_STREAM_FAILED",
            "音声認識への接続待ちが長いため翻訳を停止します。",
          );
        }
        return;
      }
      const monoPcm = decodeDiscordOpusPacketToMono(speaker.decoder, packet);
      if (!monoPcm) {
        this.#observeFlow("voice_packet_dropped");
        return;
      }
      speaker.stt.sendAudio(monoPcm);
      speaker.turnFinalizer.audioReceived();
      if (!speaker.burstHasPacket) {
        speaker.burstHasPacket = true;
        this.#observeFlow("voice_first_packet_received");
      }
      const receivedAt = performance.now();
      speaker.lastAudioAtMonotonic = receivedAt;
      this.#lastHumanAudioAt = receivedAt;
    } catch (error) {
      this.#fail("SONIOX_STREAM_FAILED", "音声の変換または送信に失敗しました。", error);
    }
  }

  #handleSpeakingEnd(userId: string): void {
    const speaker = this.#speakers.get(userId);
    if (!speaker) return;
    this.#observeFlow("voice_speaking_ended");
    speaker.turnFinalizer.speakingEnded();
  }

  #handleSttResult(speaker: SpeakerStream, result: RealtimeResult): void {
    if (
      this.#stopping ||
      speaker.closed ||
      !this.#participants.has(speaker.userId)
    ) {
      return;
    }
    this.#observeSttResult();
    try {
      const fingerprint = transcriptFingerprint(result);
      if (fingerprint !== undefined && fingerprint !== speaker.lastTranscriptFingerprint) {
        speaker.lastTranscriptFingerprint = fingerprint;
        speaker.turnFinalizer.transcriptProgressed();
      }
      for (const token of result.tokens) {
        speaker.pendingTextCharacters += Array.from(token.text).length;
      }
      void this.#unsupportedLanguageWarning.handle(speaker.userId, result);
      const preview = speaker.utterance.accept(result.tokens);
      if (preview) this.#schedulePreview(speaker, preview);
    } catch (error) {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    }
  }

  #handleSttBoundary(speaker: SpeakerStream, kind: SttBoundaryKind): void {
    if (
      this.#stopping ||
      speaker.closed ||
      !this.#participants.has(speaker.userId)
    ) {
      return;
    }
    if (!speaker.turnFinalizer.boundaryReceived(kind)) return;
    delete speaker.lastTranscriptFingerprint;
    this.#handleEndpoint(speaker);
  }

  #handleEndpoint(speaker: SpeakerStream): void {
    try {
      if (
        this.#stopping ||
        speaker.closed ||
        !this.#participants.has(speaker.userId)
      ) {
        return;
      }
      if (speaker.previewTimer) {
        clearTimeout(speaker.previewTimer);
        delete speaker.previewTimer;
      }
      delete speaker.pendingPreview;
      this.#flushSpeakerUsage(speaker);
      const finalized = speaker.utterance.takeAtEndpoint();
      if (!finalized) {
        this.#observeFlow("stt_endpoint_empty");
        void this.#captions.discardPreview(speaker.turnId);
        speaker.turnId = randomUUID();
        return;
      }
      this.#observeFlow("stt_endpoint_finalized");
      const displayName = this.#guild.members.cache.get(speaker.userId)?.displayName;
      if (!displayName) {
        this.#fail("VOICE_CONNECTION_LOST", "発話者のDiscord情報を確認できませんでした。");
        return;
      }
      const utteranceId = speaker.turnId;
      speaker.turnId = randomUUID();
      this.#observeQuality(createTranslationQualityObservation({
        traceId: utteranceId,
        sourceLanguage: finalized.sourceLanguage,
        targetLanguage: finalized.targetLanguage,
        originalText: finalized.originalText,
        translatedText: finalized.translatedText,
        ...(finalized.originalConfidence
          ? { originalConfidence: finalized.originalConfidence }
          : {}),
      }));
      this.#latency.start(
        utteranceId,
        speaker.lastAudioAtMonotonic ?? performance.now(),
      );
      this.#processor.enqueue({
        ...finalized,
        utteranceId,
        sessionId: this.#session.sessionId,
        speakerUserId: speaker.userId,
        speakerDisplayName: displayName,
        voiceId: this.#voiceAssignments.get(speaker.userId),
      });
    } catch (error) {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    }
  }

  #flushSpeakerUsage(speaker: SpeakerStream): void {
    if (speaker.lastUsageAtMonotonic === undefined) return;
    const nowMonotonic = performance.now();
    const audioMs = Math.max(0, Math.floor(nowMonotonic - speaker.lastUsageAtMonotonic));
    const textCharacterCount = speaker.pendingTextCharacters;
    speaker.lastUsageAtMonotonic = nowMonotonic;
    speaker.pendingTextCharacters = 0;
    if (audioMs === 0 && textCharacterCount === 0) return;
    this.#ledger.recordProviderUsage({
      requestRef: speaker.requestRef,
      audioMs,
      textCharacterCount,
      at: new Date(),
    });
  }

  #closeSpeaker(
    userId: string,
    status: "completed" | "failed",
  ): void {
    const speaker = this.#speakers.get(userId);
    if (!speaker || speaker.closed) return;
    speaker.closed = true;
    this.#speakers.delete(userId);
    speaker.startupOpus.clear();
    speaker.utterance.discard();
    speaker.turnFinalizer.close();
    const cleanupErrors: unknown[] = [];
    if (speaker.keepaliveTimer) clearInterval(speaker.keepaliveTimer);
    if (speaker.usageTimer) clearInterval(speaker.usageTimer);
    if (speaker.previewTimer) clearTimeout(speaker.previewTimer);
    if (speaker.receiveRecoveryTimer) clearTimeout(speaker.receiveRecoveryTimer);
    speaker.opus.destroy();
    try {
      this.#flushSpeakerUsage(speaker);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      speaker.stt.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.#ledger.finishProviderRequest(speaker.requestRef, status, new Date());
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "発話者の音声ストリームを正常に終了できませんでした");
    }
  }

  async #recoverVoiceConnection(): Promise<void> {
    if (this.#stopping) return;
    try {
      await Promise.race([
        entersState(
          this.#connection,
          VoiceConnectionStatus.Signalling,
          this.#config.limits.voiceReconnectTimeoutMs,
        ),
        entersState(
          this.#connection,
          VoiceConnectionStatus.Connecting,
          this.#config.limits.voiceReconnectTimeoutMs,
        ),
      ]);
    } catch (error) {
      this.#fail(
        "VOICE_CONNECTION_LOST",
        "Discord Voiceへ再接続できないため翻訳を停止します。",
        error,
      );
    }
  }

  #fail(reason: string, publicMessage: string, cause?: unknown): void {
    if (this.#stopping || this.#failureSent) return;
    this.#failureSent = true;
    this.#onFailure(this.#session.guildId, reason, publicMessage, cause);
  }

  #schedulePreview(speaker: SpeakerStream, preview: InterimUtterance): void {
    speaker.pendingPreview = preview;
    if (speaker.previewTimer) return;
    const elapsed = performance.now() - speaker.lastPreviewAtMonotonic;
    const delayMs = Math.max(0, interimCaptionThrottleMs - elapsed);
    speaker.previewTimer = setTimeout(() => {
      delete speaker.previewTimer;
      const latest = speaker.pendingPreview;
      delete speaker.pendingPreview;
      if (!latest || speaker.closed || this.#stopping) return;
      const displayName = this.#guild.members.cache.get(speaker.userId)?.displayName;
      if (!displayName) return;
      speaker.lastPreviewAtMonotonic = performance.now();
      void this.#captions.preview({
        utteranceId: speaker.turnId,
        speakerDisplayName: displayName,
        originalText: latest.originalText,
        translatedText: latest.translatedText,
      }).catch((error: unknown) => {
        if (error instanceof ApplicationError && error.code === "CAPTION_SEND_FAILED") {
          this.#fail(error.code, error.publicMessage, error);
          return;
        }
        this.#onWarning(this.#session.guildId, "caption_preview", error);
      });
    }, delayMs);
    speaker.previewTimer.unref();
  }

  async #refreshPresentation(
    override: Partial<{
      playbackMode: import("../session/session-settings.js").PlaybackMode;
      ttsSpeed: number;
      audioEnabled: boolean;
      queueWaitMs: number;
    }> = {},
  ): Promise<void> {
    const participantDisplayNames = [...this.#participants].map((userId) =>
      this.#guild.members.cache.get(userId)?.displayName ?? "参加者");
    const playbackMode = override.playbackMode ?? this.#session.playbackMode;
    let queueWaitMs = override.queueWaitMs ?? this.#processor.currentQueueWaitMs();
    if (
      playbackMode === "accuracy" &&
      this.#accuracyDelayWarning &&
      performance.now() < this.#accuracyDelayWarning.expiresAt
    ) {
      queueWaitMs = Math.max(queueWaitMs, this.#accuracyDelayWarning.queueWaitMs);
    } else if (
      playbackMode !== "accuracy" ||
      (
        this.#accuracyDelayWarning !== undefined &&
        performance.now() >= this.#accuracyDelayWarning.expiresAt
      )
    ) {
      this.#accuracyDelayWarning = undefined;
    }
    await this.#presentation.update({
      participantDisplayNames,
      playbackMode,
      ttsSpeed: override.ttsSpeed ?? this.#session.ttsSpeed,
      audioEnabled: override.audioEnabled ?? this.#session.audioEnabled,
      queueWaitMs,
    });
  }
}
