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
  type TextChannel,
  type VoiceChannel,
} from "discord.js";
import {
  AuthError,
  QuotaError,
  type RealtimeResult,
  type RealtimeSttSession,
} from "@soniox/node";

import type { AppConfig } from "../config.js";
import { decodeDiscordOpusPacketToMono } from "../audio/pcm.js";
import { ApplicationError } from "../domain/application-error.js";
import { languagesForPair } from "../domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";
import type { TranslationFlowObserver } from "../observability/translation-flow.js";
import type {
  SessionDescriptor,
  SessionRuntime,
  TranslationSessionDriver,
} from "../session/session-manager.js";
import { SonioxSttFactory } from "../soniox/control.js";
import type { TtsGateway } from "../translation/utterance-processor.js";
import { StreamingUtterance } from "../translation/streaming-utterance.js";
import { UtteranceProcessor } from "../translation/utterance-processor.js";
import type { UsageLedger } from "../usage/usage-ledger.js";
import { DiscordCaptionGateway } from "./caption-gateway.js";
import { DiscordPlaybackGateway } from "./playback-gateway.js";

const { OpusEncoder } = opus;

export type RuntimeFailureHandler = (
  guildId: string,
  reason: string,
  publicMessage: string,
  cause?: unknown,
) => void;

type DiscordTranslationDriverOptions = {
  client: Client;
  config: AppConfig;
  ledger: UsageLedger;
  sttFactory: SonioxSttFactory;
  tts: TtsGateway;
  latency: TranslationLatencyRecorder;
  observeFlow?: TranslationFlowObserver;
  onFailure: RuntimeFailureHandler;
};

type SpeakerStream = {
  userId: string;
  requestRef: string;
  opus: AudioReceiveStream;
  decoder: InstanceType<typeof OpusEncoder>;
  stt: RealtimeSttSession;
  utterance: StreamingUtterance;
  burstHasPacket: boolean;
  lastUsageAtMonotonic?: number;
  lastAudioAtMonotonic?: number;
  pendingTextCharacters: number;
  keepaliveTimer?: NodeJS.Timeout;
  usageTimer?: NodeJS.Timeout;
  closed: boolean;
};

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

export class DiscordTranslationDriver implements TranslationSessionDriver {
  readonly #client: Client;
  readonly #config: AppConfig;
  readonly #ledger: UsageLedger;
  readonly #sttFactory: SonioxSttFactory;
  readonly #tts: TtsGateway;
  readonly #latency: TranslationLatencyRecorder;
  readonly #observeFlow: TranslationFlowObserver;
  readonly #onFailure: RuntimeFailureHandler;

  public constructor(options: DiscordTranslationDriverOptions) {
    this.#client = options.client;
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#sttFactory = options.sttFactory;
    this.#tts = options.tts;
    this.#latency = options.latency;
    this.#observeFlow = options.observeFlow ?? (() => undefined);
    this.#onFailure = (guildId, reason, publicMessage, cause) => {
      options.onFailure(guildId, reason, publicMessage, cause);
    };
  }

  public async start(
    session: Readonly<SessionDescriptor>,
    participantIds: readonly string[],
  ): Promise<SessionRuntime> {
    const guild = this.#client.guilds.cache.get(session.guildId);
    if (!guild) throw new Error("Discord Guildがクライアントキャッシュにありません");
    const [voiceChannel, textChannel] = await Promise.all([
      guild.channels.fetch(session.voiceChannelId),
      guild.channels.fetch(session.textChannelId),
    ]);
    if (voiceChannel?.type !== ChannelType.GuildVoice) {
      throw new Error("対象チャンネルはGuild Voice Channelではありません");
    }
    if (textChannel?.type !== ChannelType.GuildText) {
      throw new Error("字幕チャンネルはGuild Text Channelではありません");
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
    try {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      this.#assertParticipantsUnchanged(voiceChannel, participantIds);
      return new DiscordTranslationRuntime({
        session,
        participantIds,
        guild,
        voiceChannel,
        textChannel,
        connection,
        config: this.#config,
        ledger: this.#ledger,
        sttFactory: this.#sttFactory,
        tts: this.#tts,
        latency: this.#latency,
        observeFlow: this.#observeFlow,
        onFailure: this.#onFailure,
      });
    } catch (error) {
      connection?.destroy();
      this.#ledger.finishSession(session.sessionId, "START_FAILED", new Date());
      throw error;
    }
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

type TranslationRuntimeOptions = {
  session: Readonly<SessionDescriptor>;
  participantIds: readonly string[];
  guild: Guild;
  voiceChannel: VoiceChannel;
  textChannel: TextChannel;
  connection: VoiceConnection;
  config: AppConfig;
  ledger: UsageLedger;
  sttFactory: SonioxSttFactory;
  tts: TtsGateway;
  latency: TranslationLatencyRecorder;
  observeFlow: TranslationFlowObserver;
  onFailure: RuntimeFailureHandler;
};

class DiscordTranslationRuntime implements SessionRuntime {
  readonly #session: Readonly<SessionDescriptor>;
  readonly #guild: Guild;
  readonly #voiceChannel: VoiceChannel;
  readonly #textChannel: TextChannel;
  readonly #connection: VoiceConnection;
  readonly #config: AppConfig;
  readonly #ledger: UsageLedger;
  readonly #sttFactory: SonioxSttFactory;
  readonly #tts: TtsGateway;
  readonly #latency: TranslationLatencyRecorder;
  readonly #observeFlow: TranslationFlowObserver;
  readonly #onFailure: RuntimeFailureHandler;
  readonly #player: AudioPlayer;
  readonly #processor: UtteranceProcessor;
  readonly #participants: Set<string>;
  readonly #speakers = new Map<string, SpeakerStream>();
  readonly #warnedUnsupported = new Set<string>();
  readonly #speakingListener: (userId: string) => void;
  readonly #speakingEndListener: (userId: string) => void;
  readonly #maxSessionTimer: NodeJS.Timeout;
  readonly #idleTimer: NodeJS.Timeout;
  #lastHumanAudioAt = performance.now();
  #stopping = false;
  #failureSent = false;

  public constructor(options: TranslationRuntimeOptions) {
    this.#session = options.session;
    this.#guild = options.guild;
    this.#voiceChannel = options.voiceChannel;
    this.#textChannel = options.textChannel;
    this.#connection = options.connection;
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#sttFactory = options.sttFactory;
    this.#tts = options.tts;
    this.#latency = options.latency;
    this.#observeFlow = options.observeFlow;
    this.#onFailure = (guildId, reason, publicMessage, cause) => {
      options.onFailure(guildId, reason, publicMessage, cause);
    };
    this.#participants = new Set(options.participantIds);
    this.#player = createAudioPlayer();
    this.#connection.subscribe(this.#player);
    const captions = new DiscordCaptionGateway(this.#textChannel);
    const playback = new DiscordPlaybackGateway(this.#player, options.latency);
    this.#processor = new UtteranceProcessor({
      captions,
      playback,
      tts: options.tts,
      maxQueueWaitMs: options.config.limits.playbackQueueMaxMs,
      maxSourceDurationMs: options.config.limits.utteranceMaxSourceSeconds * 1000,
      maxInputCharacters: options.config.limits.ttsMaxInputCharacters,
      latency: options.latency,
      onFatal: (error) => this.#fail(error.code, error.publicMessage),
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
  }

  public async stop(reason: string): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    const cleanupErrors: unknown[] = [];
    clearTimeout(this.#maxSessionTimer);
    clearInterval(this.#idleTimer);
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
    this.#observeFlow("voice_speaking_started");
    this.#tts.warm?.();
    const existing = this.#speakers.get(userId);
    if (existing) {
      existing.burstHasPacket = false;
      return;
    }

    const opus = this.#connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    opus.pause();
    const requestRef = randomUUID();
    const stt = this.#sttFactory.create(this.#session.pair, requestRef);
    const speaker: SpeakerStream = {
      userId,
      requestRef,
      opus,
      decoder: new OpusEncoder(48_000, 2),
      stt: stt.session,
      utterance: new StreamingUtterance({
        pair: this.#session.pair,
        maxSourceDurationMs: this.#config.limits.utteranceMaxSourceSeconds * 1_000,
        maxInputCharacters: this.#config.limits.ttsMaxInputCharacters,
      }),
      burstHasPacket: false,
      pendingTextCharacters: stt.initialTextCharacterCount,
      closed: false,
    };
    this.#speakers.set(userId, speaker);
    void this.#connectSpeaker(speaker).catch((error: unknown) => {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    });
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
      this.#handleEndpoint(speaker);
    });
    speaker.stt.on("error", (error) => {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    });
    await speaker.stt.connect();
    if (this.#stopping || speaker.closed) {
      speaker.stt.close();
      return;
    }

    speaker.lastUsageAtMonotonic = performance.now();
    speaker.opus.on("data", (packet: Buffer) => {
      try {
        if (
          this.#stopping ||
          !this.#participants.has(speaker.userId) ||
          !this.#config.discord.allowedUserIds.has(speaker.userId)
        ) {
          return;
        }
        const monoPcm = decodeDiscordOpusPacketToMono(speaker.decoder, packet);
        if (!monoPcm) {
          this.#observeFlow("voice_packet_dropped");
          return;
        }
        speaker.stt.sendAudio(monoPcm);
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
    });
    speaker.opus.on("error", (error) => {
      this.#fail("VOICE_CONNECTION_LOST", "Discordの音声受信に失敗しました。", error);
    });
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
    speaker.opus.resume();
  }

  #handleSpeakingEnd(userId: string): void {
    if (this.#speakers.has(userId)) this.#observeFlow("voice_speaking_ended");
  }

  #handleSttResult(speaker: SpeakerStream, result: RealtimeResult): void {
    try {
      const pairLanguages = new Set(languagesForPair(this.#session.pair));
      for (const token of result.tokens) {
        speaker.pendingTextCharacters += Array.from(token.text).length;
        if (
          token.is_final &&
          token.translation_status === "none" &&
          token.language !== undefined &&
          !pairLanguages.has(token.language as "ja" | "ko" | "en") &&
          !this.#warnedUnsupported.has(speaker.userId)
        ) {
          this.#warnedUnsupported.add(speaker.userId);
          void this.#textChannel.send({
            content: "選択した言語ペア以外の発話を検出したため、この発話は読み上げません。",
            allowedMentions: { parse: [] },
          }).catch((error: unknown) => {
            this.#fail("CAPTION_SEND_FAILED", "警告を字幕チャンネルへ投稿できませんでした。", error);
          });
        }
      }
      speaker.utterance.accept(result.tokens);
    } catch (error) {
      const mapped = mapSttError(error);
      this.#fail(mapped.code, mapped.publicMessage, error);
    }
  }

  #handleEndpoint(speaker: SpeakerStream): void {
    try {
      if (this.#stopping) return;
      this.#flushSpeakerUsage(speaker);
      const finalized = speaker.utterance.takeAtEndpoint();
      if (!finalized) {
        this.#observeFlow("stt_endpoint_empty");
        return;
      }
      this.#observeFlow("stt_endpoint_finalized");
      const displayName = this.#guild.members.cache.get(speaker.userId)?.displayName;
      if (!displayName) {
        this.#fail("VOICE_CONNECTION_LOST", "発話者のDiscord情報を確認できませんでした。");
        return;
      }
      const utteranceId = randomUUID();
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
    speaker.utterance.discard();
    const cleanupErrors: unknown[] = [];
    if (speaker.keepaliveTimer) clearInterval(speaker.keepaliveTimer);
    if (speaker.usageTimer) clearInterval(speaker.usageTimer);
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
}
