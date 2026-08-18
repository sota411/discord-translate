import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Interaction,
  type VoiceState,
} from "discord.js";

import type {
  CommandResult,
  TranslationCommandService,
} from "../commands/translation-command-service.js";
import type { SafeLogger } from "../observability/logger.js";
import {
  createStopMessagePayload,
  createTextCardMessagePayload,
} from "./message-payload.js";

type CommandService = Pick<
  TranslationCommandService,
  "execute" | "getSession" | "handleVoiceParticipantsChanged" | "stopForFailure"
>;

type DiscordBotControllerOptions = {
  client: Client;
  commands: CommandService;
  logger: SafeLogger;
};

export class DiscordBotController {
  readonly #client: Client;
  readonly #commands: CommandService;
  readonly #logger: SafeLogger;
  readonly #interactionListener: (interaction: Interaction) => void;
  readonly #voiceStateListener: (oldState: VoiceState, newState: VoiceState) => void;
  #acceptingCommands = true;
  #attached = false;

  public constructor(options: DiscordBotControllerOptions) {
    this.#client = options.client;
    this.#commands = options.commands;
    this.#logger = options.logger;
    this.#interactionListener = (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleInteraction(interaction).catch((error: unknown) => {
          this.#logger.error("discord_interaction_response_failed", error, {
            guild_id: this.#guildLogId(interaction.guildId),
          });
        });
      }
    };
    this.#voiceStateListener = (oldState, newState) => {
      void this.handleVoiceStateUpdate(oldState, newState).catch((error: unknown) => {
        this.#logger.error("voice_state_response_failed", error, {
          guild_id: this.#logger.pseudonymize(newState.guild.id),
        });
      });
    };
  }

  public attach(): void {
    if (this.#attached) return;
    this.#client.on(Events.InteractionCreate, this.#interactionListener);
    this.#client.on(Events.VoiceStateUpdate, this.#voiceStateListener);
    this.#attached = true;
  }

  public stopAcceptingCommands(): void {
    this.#acceptingCommands = false;
  }

  public detach(): void {
    if (!this.#attached) return;
    this.#client.off(Events.InteractionCreate, this.#interactionListener);
    this.#client.off(Events.VoiceStateUpdate, this.#voiceStateListener);
    this.#attached = false;
  }

  public async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "translate") return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!this.#acceptingCommands) {
      await interaction.editReply("Botを停止中です。起動後に再実行してください。");
      return;
    }

    try {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand !== "start" && subcommand !== "stop") {
        throw new Error("未対応のtranslateサブコマンドです");
      }
      const result = subcommand === "start"
        ? await this.#commands.execute(this.#startInput(interaction))
        : await this.#commands.execute(this.#stopInput(interaction));
      await this.#completeInteraction(interaction, result, subcommand);
    } catch (error) {
      this.#logger.error("discord_interaction_failed", error, {
        guild_id: this.#guildLogId(interaction.guildId),
      });
      await interaction.editReply(
        "コマンドを処理できませんでした。時間を置いて再実行してください。",
      );
    }
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const guildId = newState.guild.id;
    const session = this.#commands.getSession(guildId);
    if (
      !session ||
      session.state === "FAILED" ||
      session.state === "STOPPING"
    ) {
      return;
    }
    const isBot = newState.id === this.#client.user?.id;
    const affectsSession =
      oldState.channelId === session.voiceChannelId ||
      newState.channelId === session.voiceChannelId;
    if (!isBot && !affectsSession) return;

    try {
      if (
        isBot &&
        session.state === "ACTIVE" &&
        newState.channelId !== session.voiceChannelId
      ) {
        if (await this.#commands.stopForFailure(guildId, "BOT_VOICE_REMOVED")) {
          await this.#postAutomaticStop(
            newState.guild,
            session.textChannelId,
            "BOT_VOICE_REMOVED",
          );
        }
        return;
      }

      const voiceChannel = newState.guild.channels.cache.get(session.voiceChannelId);
      if (voiceChannel?.type !== ChannelType.GuildVoice) {
        await this.handleRuntimeFailure(
          guildId,
          "VOICE_CONNECTION_LOST",
          "対象音声チャンネルを確認できないため、翻訳を停止しました。",
        );
        return;
      }
      const participantIds = [...voiceChannel.members.values()]
        .filter((member) => !member.user.bot)
        .map((member) => member.id);
      const result = await this.#commands.handleVoiceParticipantsChanged(
        guildId,
        participantIds,
      );
      if (result.stopped && result.reason) {
        await this.#postAutomaticStop(
          newState.guild,
          session.textChannelId,
          result.reason,
        );
      }
    } catch (error) {
      this.#logger.error("voice_state_update_failed", error, {
        guild_id: this.#logger.pseudonymize(guildId),
      });
      await this.handleRuntimeFailure(
        guildId,
        "VOICE_CONNECTION_LOST",
        "参加者の変更を処理できないため、翻訳を停止しました。",
        error,
      );
    }
  }

  public async handleRuntimeFailure(
    guildId: string,
    reason: string,
    _publicMessage: string,
    cause?: unknown,
  ): Promise<void> {
    const session = this.#commands.getSession(guildId);
    if (!session) return;
    this.#logger.error("translation_runtime_failed", cause, {
      guild_id: this.#logger.pseudonymize(guildId),
      session_id: session.sessionId,
      reason,
    });
    if (await this.#commands.stopForFailure(guildId, reason)) {
      await this.#postStopMessage(session.textChannelId, reason)
        .catch((error: unknown) => {
          this.#logger.error("automatic_stop_notification_failed", error, {
            guild_id: this.#logger.pseudonymize(guildId),
            reason,
          });
        });
    }
  }

  #startInput(interaction: ChatInputCommandInteraction) {
    const guild = interaction.guild;
    const textChannel = interaction.channel;
    const actor = guild?.members.cache.get(interaction.user.id);
    const voiceChannel = actor?.voice.channel;
    const bot = guild?.members.me;
    const voicePermissions = voiceChannel && bot
      ? voiceChannel.permissionsFor(bot)
      : undefined;
    const textPermissions = textChannel && bot && "permissionsFor" in textChannel
      ? textChannel.permissionsFor(bot)
      : undefined;
    const isGuildText = textChannel?.type === ChannelType.GuildText;
    return {
      kind: "start" as const,
      pair: interaction.options.getString("pair", true),
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
      actorCanManageGuild:
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
      voiceChannel: voiceChannel
        ? {
            id: voiceChannel.id,
            name: voiceChannel.name,
            humanParticipantIds: [...voiceChannel.members.values()]
              .filter((member) => !member.user.bot)
              .map((member) => member.id),
          }
        : undefined,
      textChannel: {
        id: isGuildText ? textChannel.id : "",
        name: isGuildText ? textChannel.name : "",
      },
      botPermissions: {
        voice: {
          viewChannel: voicePermissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
          connect: voicePermissions?.has(PermissionFlagsBits.Connect) ?? false,
          speak: voicePermissions?.has(PermissionFlagsBits.Speak) ?? false,
        },
        text: {
          viewChannel: textPermissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
          sendMessages: textPermissions?.has(PermissionFlagsBits.SendMessages) ?? false,
        },
      },
    };
  }

  #stopInput(interaction: ChatInputCommandInteraction) {
    const actor = interaction.guild?.members.cache.get(interaction.user.id);
    return {
      kind: "stop" as const,
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
      actorCanManageGuild:
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
      actorVoiceChannelId: actor?.voice.channelId ?? undefined,
    };
  }

  async #completeInteraction(
    interaction: ChatInputCommandInteraction,
    result: CommandResult,
    subcommand: string,
  ): Promise<void> {
    if (!result.ok || !result.publicMessage) {
      await interaction.editReply(result.interactionMessage);
      return;
    }
    try {
      await this.#postMessage(
        result.publicMessage.channelId,
        result.publicMessage.content,
      );
      await interaction.editReply(result.interactionMessage);
    } catch (error) {
      if (subcommand === "start" && interaction.guildId) {
        this.#logger.error("start_notification_failed", error, {
          guild_id: this.#logger.pseudonymize(interaction.guildId),
        });
        await this.#commands.stopForFailure(
          interaction.guildId,
          "CAPTION_SEND_FAILED",
        );
        await interaction.editReply(
          "開始通知を字幕チャンネルへ投稿できないため、翻訳を停止しました。権限を確認してください。",
        );
        return;
      }
      this.#logger.error("public_command_notification_failed", error, {
        guild_id: this.#guildLogId(interaction.guildId),
      });
      await interaction.editReply(
        `${result.interactionMessage} ただし、終了通知をチャンネルへ投稿できませんでした。`,
      );
    }
  }

  async #postAutomaticStop(
    guild: Guild,
    channelId: string,
    reason: string,
  ): Promise<void> {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error("字幕チャンネルが見つかりません");
      await channel.send(createStopMessagePayload(reason));
    } catch (error) {
      this.#logger.error("automatic_stop_notification_failed", error, {
        guild_id: this.#logger.pseudonymize(guild.id),
        reason,
      });
    }
  }

  async #postMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.#client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("字幕チャンネルが見つかりません");
    await (channel as GuildTextBasedChannel).send(createTextCardMessagePayload(content));
  }

  async #postStopMessage(channelId: string, reason: string): Promise<void> {
    const channel = await this.#client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("字幕チャンネルが見つかりません");
    await (channel as GuildTextBasedChannel).send(createStopMessagePayload(reason));
  }

  #guildLogId(guildId: string | null): string {
    return guildId ? this.#logger.pseudonymize(guildId) : "none";
  }
}
