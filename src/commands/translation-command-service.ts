import {
  ApplicationError,
  type ErrorCode,
} from "../domain/application-error.js";
import {
  isLanguagePair,
  languagePairLabels,
  type LanguagePair,
} from "../domain/language-pair.js";
import type { SessionManager } from "../session/session-manager.js";

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
  };
};

export type StartCommandInput = {
  kind: "start";
  pair: string;
  guildId: string | undefined;
  actorId: string;
  actorCanManageGuild: boolean;
  voiceChannel: VoiceChannelInput | undefined;
  textChannel: TextChannelInput;
  botPermissions: BotPermissions;
};

export type StopCommandInput = {
  kind: "stop";
  guildId: string | undefined;
  actorId: string;
  actorCanManageGuild: boolean;
  actorVoiceChannelId: string | undefined;
};

export type TranslationCommandInput = StartCommandInput | StopCommandInput;

export type CommandResult = {
  ok: boolean;
  ephemeral: true;
  interactionMessage: string;
  code?: ErrorCode;
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
};

export type VoiceParticipantsChangeResult = {
  stopped: boolean;
  reason?: "SPEAKER_NOT_ALLOWED" | "TOO_MANY_SPEAKERS" | "VOICE_EMPTY";
};

export class TranslationCommandService {
  readonly #allowedGuildIds: ReadonlySet<string>;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #maxSpeakersPerSession: number;
  readonly #sessions: SessionManager;

  public constructor(dependencies: TranslationCommandServiceDependencies) {
    this.#allowedGuildIds = dependencies.allowedGuildIds;
    this.#allowedUserIds = dependencies.allowedUserIds;
    this.#maxSpeakersPerSession = dependencies.maxSpeakersPerSession;
    this.#sessions = dependencies.sessions;
  }

  public async execute(input: TranslationCommandInput): Promise<CommandResult> {
    try {
      return input.kind === "start"
        ? await this.#start(input)
        : await this.#stop(input);
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

    await this.#sessions.updateParticipants(guildId, participantIds);
    return { stopped: false };
  }

  async #start(input: StartCommandInput): Promise<CommandResult> {
    const guildId = this.#requireAllowedGuild(input.guildId);
    if (!this.#allowedUserIds.has(input.actorId)) {
      throw new ApplicationError(
        "USER_NOT_ALLOWED",
        "このBotはprivate betaです。許可された利用者だけが開始できます。",
      );
    }
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

    await this.#sessions.start({
      guildId,
      voiceChannelId: input.voiceChannel.id,
      voiceChannelName: input.voiceChannel.name,
      textChannelId: input.textChannel.id,
      textChannelName: input.textChannel.name,
      startedByUserId: input.actorId,
      pair: input.pair,
      participantIds: input.voiceChannel.humanParticipantIds,
    });

    return {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳を開始しました。音声チャンネルへ開始通知を投稿しました。",
      publicMessage: {
        channelId: input.textChannel.id,
        content: this.#startMessage(
          input.pair,
          input.voiceChannel.name,
          input.textChannel.name,
        ),
      },
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
    const mayStop =
      input.actorId === session.startedByUserId ||
      input.actorVoiceChannelId === session.voiceChannelId ||
      input.actorCanManageGuild;
    if (!mayStop) {
      throw new ApplicationError(
        "STOP_NOT_ALLOWED",
        "この翻訳セッションを停止する権限がありません。",
      );
    }

    await this.#sessions.stop(guildId, "USER_REQUEST");
    return {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳セッションを停止しました。",
      publicMessage: {
        channelId: session.textChannelId,
        content: "翻訳セッションを停止しました。理由: 利用者による停止",
      },
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

  #missingPermissions(permissions: BotPermissions): string[] {
    const missing: string[] = [];
    if (!permissions.voice.viewChannel) missing.push("Voice ViewChannel");
    if (!permissions.voice.connect) missing.push("Voice Connect");
    if (!permissions.voice.speak) missing.push("Voice Speak");
    if (!permissions.text.viewChannel) missing.push("Text ViewChannel");
    if (!permissions.text.sendMessages) missing.push("Text SendMessages");
    return missing;
  }

  #startMessage(
    pair: LanguagePair,
    voiceChannelName: string,
    textChannelName: string,
  ): string {
    return [
      "翻訳を開始しました",
      `音声チャンネル: ${voiceChannelName}`,
      `言語: ${languagePairLabels[pair]}`,
      `字幕: #${textChannelName}`,
      "終了条件: /translate stop、時間上限、無音上限、参加者不在、利用上限",
      "",
      "同時発話では翻訳音声が順番待ちになります。",
      "このセッションの会話音声は、リアルタイム処理のためSonioxへ送信されます。",
      "Botサーバーは音声と字幕本文を保存しません。字幕はDiscord上に残ります。",
    ].join("\n");
  }
}
