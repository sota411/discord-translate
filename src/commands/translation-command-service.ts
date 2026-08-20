import {
  ApplicationError,
  type ErrorCode,
} from "../domain/application-error.js";
import type { TranslationTermCatalog } from "../config/translation-term-catalog.js";
import {
  isLanguagePair,
} from "../domain/language-pair.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionDescriptor } from "../session/session-manager.js";
import {
  isCaptionFailurePolicy,
  isPlaybackMode,
  type CaptionFailurePolicy,
  type PlaybackMode,
} from "../session/session-settings.js";

type VoiceChannelInput = {
  id: string;
  name: string;
  humanParticipantIds: readonly string[];
};

type TextChannelInput = {
  id: string;
  name: string;
};

type BotPermissions = {
  voice: {
    viewChannel: boolean;
    connect: boolean;
    speak: boolean;
  };
  text: {
    viewChannel: boolean;
    sendMessages: boolean;
    createPublicThreads: boolean;
    sendMessagesInThreads: boolean;
    manageThreads: boolean;
  };
};

export type StartCommandInput = {
  kind: "start";
  pair: string;
  mode?: string;
  guildId: string | undefined;
  actorId: string;
  actorCanManageGuild: boolean;
  voiceChannel: VoiceChannelInput | undefined;
  textChannel: TextChannelInput;
  botPermissions: BotPermissions;
};

export type StopCommandInput = {
  kind: "stop";
  sessionId?: string;
  guildId: string | undefined;
  actorId: string;
  actorCanManageGuild: boolean;
  actorVoiceChannelId: string | undefined;
};

export type SessionControlInput = {
  kind: "control";
  action:
    | "show_settings"
    | "toggle_audio"
    | "set_playback_mode"
    | "set_caption_failure_policy";
  value?: string;
  sessionId: string;
  guildId: string | undefined;
  actorId: string;
  actorCanManageGuild: boolean;
  actorVoiceChannelId: string | undefined;
};

export type StatusCommandInput = {
  kind: "status";
  guildId: string | undefined;
  actorId: string;
};

export type ExportCommandInput = {
  kind: "export";
  guildId: string | undefined;
  actorId: string;
};

export type RegisterCommandInput = {
  kind: "register";
  pair: string;
  source: string;
  target: string;
  guildId: string | undefined;
  actorId: string;
};

export type TranslationCommandInput =
  | StartCommandInput
  | StopCommandInput
  | SessionControlInput
  | StatusCommandInput
  | ExportCommandInput
  | RegisterCommandInput;

export type CommandResult = {
  ok: boolean;
  ephemeral: true;
  interactionMessage: string;
  code?: ErrorCode;
  status?: Readonly<SessionDescriptor> | null;
  publicMessage?: {
    channelId: string;
    content: string;
  };
};

type TranslationCommandServiceDependencies = {
  allowedGuildIds: ReadonlySet<string>;
  allowedUserIds: ReadonlySet<string>;
  maxSpeakersPerSession: number;
  sessions: SessionManager;
  terms: Pick<TranslationTermCatalog, "snapshot" | "register">;
  now?: () => Date;
};

export type VoiceParticipantsChangeResult = {
  stopped: boolean;
  reason?:
    | "SPEAKER_NOT_ALLOWED"
    | "TOO_MANY_SPEAKERS"
    | "VOICE_EMPTY"
    | "USAGE_LIMIT_REACHED"
    | "USAGE_LEDGER_UNAVAILABLE"
    | "USAGE_RECONCILIATION_STALE";
};

export class TranslationCommandService {
  readonly #allowedGuildIds: ReadonlySet<string>;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #maxSpeakersPerSession: number;
  readonly #sessions: SessionManager;
  readonly #terms: Pick<TranslationTermCatalog, "snapshot" | "register">;
  readonly #now: () => Date;

  public constructor(dependencies: TranslationCommandServiceDependencies) {
    this.#allowedGuildIds = dependencies.allowedGuildIds;
    this.#allowedUserIds = dependencies.allowedUserIds;
    this.#maxSpeakersPerSession = dependencies.maxSpeakersPerSession;
    this.#sessions = dependencies.sessions;
    this.#terms = dependencies.terms;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async execute(input: TranslationCommandInput): Promise<CommandResult> {
    try {
      if (input.kind === "start") return await this.#start(input);
      if (input.kind === "stop") return await this.#stop(input);
      if (input.kind === "control") return await this.#control(input);
      if (input.kind === "status") return this.#status(input);
      if (input.kind === "register") return this.#register(input);
      return this.#authorizeExport(input);
    } catch (error) {
      if (!(error instanceof ApplicationError)) {
        throw error;
      }
      return {
        ok: false,
        ephemeral: true,
        code: error.code,
        interactionMessage: error.publicMessage,
      };
    }
  }

  public getSession(guildId: string): Readonly<SessionDescriptor> | undefined {
    return this.#sessions.get(guildId);
  }

  public stopForFailure(guildId: string, reason: string): Promise<boolean> {
    return this.#sessions.stop(guildId, reason);
  }

  public async handleVoiceParticipantsChanged(
    guildId: string,
    participantIds: readonly string[],
  ): Promise<VoiceParticipantsChangeResult> {
    if (!this.#sessions.get(guildId)) {
      return { stopped: false };
    }

    const unauthorized = participantIds.some(
      (participantId) => !this.#allowedUserIds.has(participantId),
    );
    if (unauthorized) {
      await this.#sessions.stop(guildId, "SPEAKER_NOT_ALLOWED");
      return { stopped: true, reason: "SPEAKER_NOT_ALLOWED" };
    }
    if (participantIds.length > this.#maxSpeakersPerSession) {
      await this.#sessions.stop(guildId, "TOO_MANY_SPEAKERS");
      return { stopped: true, reason: "TOO_MANY_SPEAKERS" };
    }
    if (participantIds.length === 0) {
      await this.#sessions.stop(guildId, "VOICE_EMPTY");
      return { stopped: true, reason: "VOICE_EMPTY" };
    }

    try {
      await this.#sessions.updateParticipants(guildId, participantIds);
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        (
          error.code !== "USAGE_LIMIT_REACHED" &&
          error.code !== "USAGE_LEDGER_UNAVAILABLE" &&
          error.code !== "USAGE_RECONCILIATION_STALE"
        )
      ) {
        throw error;
      }
      await this.#sessions.stop(guildId, error.code);
      return { stopped: true, reason: error.code };
    }
    return { stopped: false };
  }

  async #start(input: StartCommandInput): Promise<CommandResult> {
    const guildId = this.#requireAllowedGuild(input.guildId);
    this.#requireAllowedUser(input.actorId);
    if (!input.voiceChannel) {
      throw new ApplicationError(
        "VOICE_REQUIRED",
        "先に翻訳対象の音声チャンネルへ参加してください。",
      );
    }
    if (!input.voiceChannel.humanParticipantIds.includes(input.actorId)) {
      throw new ApplicationError(
        "VOICE_REQUIRED",
        "実行者が参加している音声チャンネルを確認できませんでした。",
      );
    }
    if (
      input.voiceChannel.humanParticipantIds.some(
        (participantId) => !this.#allowedUserIds.has(participantId),
      )
    ) {
      throw new ApplicationError(
        "SPEAKER_NOT_ALLOWED",
        "音声チャンネルに許可されていない利用者がいます。退出後に再実行してください。",
      );
    }
    if (input.voiceChannel.humanParticipantIds.length > this.#maxSpeakersPerSession) {
      throw new ApplicationError(
        "TOO_MANY_SPEAKERS",
        `このBotは${String(this.#maxSpeakersPerSession)}人まで利用できます。人数を減らして再実行してください。`,
      );
    }

    const missingPermissions = this.#missingPermissions(input.botPermissions);
    if (missingPermissions.length > 0) {
      throw new ApplicationError(
        "BOT_PERMISSION_MISSING",
        `Botに必要な権限がありません: ${missingPermissions.join(", ")}`,
      );
    }
    if (!isLanguagePair(input.pair)) {
      throw new ApplicationError(
        "UNSUPPORTED_PAIR",
        "対応していない言語ペアです。コマンドを再登録してください。",
      );
    }
    const playbackMode: PlaybackMode = input.mode === undefined
      ? "conversation"
      : this.#requirePlaybackMode(input.mode);
    const translationTerms = this.#terms.snapshot(guildId, input.pair);

    await this.#sessions.start({
      guildId,
      voiceChannelId: input.voiceChannel.id,
      voiceChannelName: input.voiceChannel.name,
      textChannelId: input.textChannel.id,
      textChannelName: input.textChannel.name,
      startedByUserId: input.actorId,
      pair: input.pair,
      participantIds: input.voiceChannel.humanParticipantIds,
      playbackMode,
      audioEnabled: true,
      captionFailurePolicy: "continue_audio",
      requiredSttStreams: this.#maxSpeakersPerSession,
      translationTerms,
    });

    return {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳を開始しました。専用スレッドへ字幕を表示します。",
    };
  }

  #status(input: StatusCommandInput): CommandResult {
    const guildId = this.#requireAllowedGuild(input.guildId);
    this.#requireAllowedUser(input.actorId);
    const status = this.#sessions.get(guildId) ?? null;
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: status
        ? "現在の翻訳セッションを表示します。"
        : "翻訳セッションは実行されていません。",
      status,
    };
  }

  #authorizeExport(input: ExportCommandInput): CommandResult {
    this.#requireAllowedGuild(input.guildId);
    this.#requireAllowedUser(input.actorId);
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳スレッドをエクスポートします。",
    };
  }

  #register(input: RegisterCommandInput): CommandResult {
    const guildId = this.#requireAllowedGuild(input.guildId);
    this.#requireAllowedUser(input.actorId);
    if (!isLanguagePair(input.pair)) {
      throw new ApplicationError(
        "UNSUPPORTED_PAIR",
        "対応していない言語ペアです。コマンドを再登録してください。",
      );
    }
    const result = this.#terms.register({
      guildId,
      pair: input.pair,
      source: input.source,
      target: input.target,
      at: this.#now(),
    });
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: result === "created"
        ? "翻訳用語を登録しました。次に開始する翻訳セッションから反映されます。"
        : "登録済みの翻訳用語を更新しました。次に開始する翻訳セッションから反映されます。",
    };
  }

  async #stop(input: StopCommandInput): Promise<CommandResult> {
    const guildId = this.#requireAllowedGuild(input.guildId);
    const session = this.#sessions.get(guildId);
    if (!session) {
      return {
        ok: true,
        ephemeral: true,
        interactionMessage: "翻訳セッションは実行されていません。",
      };
    }
    this.#assertSessionMatches(session, input.sessionId);
    this.#assertMayControl(session, input);

    await this.#sessions.stop(guildId, "USER_REQUEST");
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳セッションを停止しました。",
    };
  }

  async #control(input: SessionControlInput): Promise<CommandResult> {
    const guildId = this.#requireAllowedGuild(input.guildId);
    const session = this.#sessions.get(guildId);
    if (!session) {
      throw new ApplicationError(
        "SESSION_NOT_ACTIVE",
        "このカードの翻訳セッションは終了しています。",
      );
    }
    this.#assertSessionMatches(session, input.sessionId);
    this.#assertMayControl(session, input);

    if (input.action === "show_settings") {
      return {
        ok: true,
        ephemeral: true,
        interactionMessage: "セッション設定を表示します。",
      };
    }
    if (input.action === "toggle_audio") {
      const enabled = !session.audioEnabled;
      await this.#sessions.setAudioEnabled(guildId, enabled);
      return {
        ok: true,
        ephemeral: true,
        interactionMessage: enabled
          ? "翻訳音声を再開しました。"
          : "字幕のみへ変更しました。再生中と待機中の翻訳音声も停止しました。",
      };
    }
    if (input.action === "set_playback_mode") {
      const mode = this.#requirePlaybackMode(input.value ?? "");
      await this.#sessions.setPlaybackMode(guildId, mode);
      return {
        ok: true,
        ephemeral: true,
        interactionMessage: mode === "conversation"
          ? "会話優先モードへ変更しました。"
          : "正確さ優先モードへ変更しました。",
      };
    }
    const policy = this.#requireCaptionFailurePolicy(input.value ?? "");
    await this.#sessions.setCaptionFailurePolicy(guildId, policy);
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: policy === "continue_audio"
        ? "字幕を送れない場合も音声翻訳を継続します。"
        : "字幕を送れない場合はセッションを停止します。",
    };
  }

  #requireAllowedGuild(guildId: string | undefined): string {
    if (!guildId) {
      throw new ApplicationError(
        "GUILD_REQUIRED",
        "このコマンドはDiscordサーバー内で実行してください。",
      );
    }
    if (!this.#allowedGuildIds.has(guildId)) {
      throw new ApplicationError(
        "GUILD_NOT_ALLOWED",
        "このBotはprivate betaです。このサーバーでは利用できません。",
      );
    }
    return guildId;
  }

  #requireAllowedUser(actorId: string): void {
    if (this.#allowedUserIds.has(actorId)) return;
    throw new ApplicationError(
      "USER_NOT_ALLOWED",
      "このBotはprivate betaです。許可された利用者だけが実行できます。",
    );
  }

  #missingPermissions(permissions: BotPermissions): string[] {
    const missing: string[] = [];
    if (!permissions.voice.viewChannel) missing.push("Voice ViewChannel");
    if (!permissions.voice.connect) missing.push("Voice Connect");
    if (!permissions.voice.speak) missing.push("Voice Speak");
    if (!permissions.text.viewChannel) missing.push("Text ViewChannel");
    if (!permissions.text.sendMessages) missing.push("Text SendMessages");
    if (!permissions.text.createPublicThreads) missing.push("Text CreatePublicThreads");
    if (!permissions.text.sendMessagesInThreads) {
      missing.push("Text SendMessagesInThreads");
    }
    if (!permissions.text.manageThreads) missing.push("Text ManageThreads");
    return missing;
  }

  #assertSessionMatches(
    session: Readonly<SessionDescriptor>,
    expectedSessionId: string | undefined,
  ): void {
    if (expectedSessionId !== undefined && session.sessionId !== expectedSessionId) {
      throw new ApplicationError(
        "SESSION_NOT_ACTIVE",
        "このカードの翻訳セッションは終了しています。",
      );
    }
  }

  #assertMayControl(
    session: Readonly<SessionDescriptor>,
    input: Pick<StopCommandInput, "actorId" | "actorVoiceChannelId" | "actorCanManageGuild">,
  ): void {
    const mayControl =
      input.actorId === session.startedByUserId ||
      input.actorVoiceChannelId === session.voiceChannelId ||
      input.actorCanManageGuild;
    if (!mayControl) {
      throw new ApplicationError(
        "STOP_NOT_ALLOWED",
        "この翻訳セッションを操作する権限がありません。",
      );
    }
  }

  #requirePlaybackMode(value: string): PlaybackMode {
    if (isPlaybackMode(value)) return value;
    throw new ApplicationError(
      "SESSION_NOT_ACTIVE",
      "再生モードの指定が不正です。",
    );
  }

  #requireCaptionFailurePolicy(value: string): CaptionFailurePolicy {
    if (isCaptionFailurePolicy(value)) return value;
    throw new ApplicationError(
      "SESSION_NOT_ACTIVE",
      "字幕エラー時の動作指定が不正です。",
    );
  }
}
