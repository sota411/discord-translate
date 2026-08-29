import {
  AttachmentBuilder,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type PermissionsBitField,
  type PublicThreadChannel,
  type StringSelectMenuInteraction,
  type VoiceState,
} from "discord.js";

import type {
  CommandResult,
  LanguageCommandInput,
  RegisterCommandInput,
  TranslationCommandService,
} from "../commands/translation-command-service.js";
import { ApplicationError } from "../domain/application-error.js";
import { isLanguagePair } from "../domain/language-pair.js";
import type { SafeLogger } from "../observability/logger.js";
import { createSessionSettingsMessagePayload } from "./message-payload.js";
import {
  createRegisteredTermListMessagePayload,
  type RegisteredTermListFilter,
} from "./registered-term-list-message.js";
import { createSessionStatusMessage } from "./status-message.js";
import { exportThreadToMarkdown } from "./thread-export.js";

type CommandService = Pick<
  TranslationCommandService,
  "execute" | "getSession" | "handleVoiceParticipantsChanged" | "stopForFailure"
>;

type DiscordBotControllerOptions = {
  client: Client;
  commands: CommandService;
  logger: SafeLogger;
  now?: () => Date;
};

export class DiscordBotController {
  readonly #client: Client;
  readonly #commands: CommandService;
  readonly #logger: SafeLogger;
  readonly #now: () => Date;
  readonly #interactionListener: (interaction: Interaction) => void;
  readonly #voiceStateListener: (oldState: VoiceState, newState: VoiceState) => void;
  #acceptingCommands = true;
  #attached = false;

  public constructor(options: DiscordBotControllerOptions) {
    this.#client = options.client;
    this.#commands = options.commands;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#interactionListener = (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.handleAutocomplete(interaction).catch((error: unknown) => {
          this.#logger.error("discord_autocomplete_response_failed", error, {
            guild_id: this.#guildLogId(interaction.guildId),
          });
        });
        return;
      }
      if (interaction.isChatInputCommand()) {
        void this.handleInteraction(interaction).catch((error: unknown) => {
          this.#logger.error("discord_interaction_response_failed", error, {
            guild_id: this.#guildLogId(interaction.guildId),
          });
        });
        return;
      }
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        void this.handleComponentInteraction(interaction).catch((error: unknown) => {
          this.#logger.error("discord_component_response_failed", error, {
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
    if (
      !interaction.isChatInputCommand() ||
      !["translate", "status", "export", "register", "language"].includes(
        interaction.commandName,
      )
    ) {
      return;
    }

    const archivedExportThread =
      interaction.commandName === "export" &&
        interaction.channel?.type === ChannelType.PublicThread &&
        interaction.channel.archived
        ? interaction.channel
        : undefined;
    let archivedExportAuthorization: CommandResult | undefined;
    let prevalidatedExportThread: PublicThreadChannel | undefined;
    if (archivedExportThread) {
      archivedExportAuthorization = await this.#commands.execute({
        kind: "export",
        guildId: interaction.guildId ?? undefined,
        actorId: interaction.user.id,
      });
      if (!archivedExportAuthorization.ok) return;
      try {
        prevalidatedExportThread = this.#validateExportThread(interaction);
      } catch (error) {
        if (error instanceof ApplicationError) {
          this.#logger.warn("archived_export_precondition_failed", {
            guild_id: this.#guildLogId(interaction.guildId),
            error_code: error.code,
          });
          return;
        }
        throw error;
      }
      await archivedExportThread.setArchived(false, "確定字幕のエクスポート");
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!this.#acceptingCommands) {
        await interaction.editReply("Botを停止中です。起動後に再実行してください。");
        return;
      }

      try {
        if (interaction.commandName === "translate") {
          await this.#handleTranslateCommand(interaction);
          return;
        }
        if (interaction.commandName === "status") {
          await this.#handleStatusCommand(interaction);
          return;
        }
        if (interaction.commandName === "register") {
          await this.#handleRegisterCommand(interaction);
          return;
        }
        if (interaction.commandName === "language") {
          await this.#handleLanguageCommand(interaction);
          return;
        }
        await this.#handleExportCommand(
          interaction,
          archivedExportAuthorization,
          prevalidatedExportThread,
        );
      } catch (error) {
        if (error instanceof ApplicationError) {
          await interaction.editReply(error.publicMessage);
          return;
        }
        this.#logger.error("discord_interaction_failed", error, {
          guild_id: this.#guildLogId(interaction.guildId),
        });
        await interaction.editReply(
          "コマンドを処理できませんでした。時間を置いて再実行してください。",
        );
      }
    } finally {
      if (archivedExportThread) {
        try {
          await archivedExportThread.setArchived(true, "確定字幕のエクスポート完了");
        } catch (error) {
          this.#logger.error("export_thread_rearchive_failed", error, {
            guild_id: this.#guildLogId(interaction.guildId),
          });
        }
      }
    }
  }

  async #handleTranslateCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand !== "start" && subcommand !== "stop" && subcommand !== "speed") {
      throw new Error("未対応のtranslateサブコマンドです");
    }
    const result = await this.#commands.execute(
      subcommand === "start"
        ? this.#startInput(interaction)
        : subcommand === "speed"
          ? this.#speedInput(interaction)
          : this.#stopInput(interaction),
    );
    await this.#completeInteraction(interaction, result);
  }

  async #handleStatusCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const result = await this.#commands.execute({
      kind: "status",
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
    });
    if (!result.ok || !result.status) {
      await interaction.editReply(result.interactionMessage);
      return;
    }
    const displayNames = result.status.participantIds.map((participantId) =>
      interaction.guild?.members.cache.get(participantId)?.displayName ?? "参加者");
    await interaction.editReply(createSessionStatusMessage(
      result.status,
      displayNames,
      this.#now(),
    ));
  }

  async #handleRegisterCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const input = this.#registerInput(interaction);
    const result = await this.#commands.execute(input);
    if (
      input.action !== "list" ||
      !result.ok ||
      result.registeredTerms === undefined
    ) {
      await interaction.editReply(result.interactionMessage);
      return;
    }
    const filter: RegisteredTermListFilter = input.pair === undefined
      ? "all"
      : isLanguagePair(input.pair)
        ? input.pair
        : "all";
    await interaction.editReply(createRegisteredTermListMessagePayload({
      terms: result.registeredTerms,
      filter,
      requestedPage: 0,
    }));
  }

  async #handleLanguageCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const result = await this.#commands.execute(this.#languageInput(interaction));
    await this.#completeInteraction(interaction, result);
  }

  public async handleAutocomplete(
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (
      interaction.commandName !== "register" ||
      interaction.options.getSubcommand(false) !== "delete"
    ) {
      await interaction.respond([]);
      return;
    }
    const pair = interaction.options.getString("pair");
    const focused = interaction.options.getFocused(true);
    if (
      !pair ||
      !isLanguagePair(pair) ||
      focused.name !== "source" ||
      typeof focused.value !== "string"
    ) {
      await interaction.respond([]);
      return;
    }
    const result = await this.#commands.execute({
      kind: "register",
      action: "list",
      pair,
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
    });
    if (!result.ok || result.registeredTerms === undefined) {
      await interaction.respond([]);
      return;
    }
    const query = focused.value.toLowerCase();
    const choices = result.registeredTerms
      .filter((term) => term.source.toLowerCase().includes(query))
      .slice(0, 25)
      .map((term) => ({
        name: truncateChoiceName(`${term.source} → ${term.target}`),
        value: term.source,
      }));
    await interaction.respond(choices);
  }

  async #handleExportCommand(
    interaction: ChatInputCommandInteraction,
    preauthorized?: CommandResult,
    prevalidatedThread?: PublicThreadChannel,
  ): Promise<void> {
    const authorization = preauthorized ?? await this.#commands.execute({
      kind: "export",
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
    });
    if (!authorization.ok) {
      await interaction.editReply(authorization.interactionMessage);
      return;
    }

    const thread = prevalidatedThread ?? this.#validateExportThread(interaction);
    const botUserId = this.#client.user?.id;
    if (!botUserId) {
      throw new Error("Discord Bot userを確認できません");
    }
    const exported = await exportThreadToMarkdown({
      thread,
      botUserId,
      now: this.#now,
    });
    if (exported.byteLength > interaction.attachmentSizeLimit) {
      throw new ApplicationError(
        "EXPORT_TOO_LARGE",
        "MarkdownがDiscordへ添付できるサイズ上限を超えています。",
      );
    }
    const attachment = new AttachmentBuilder(
      Buffer.from(exported.markdown, "utf8"),
      { name: exported.filename },
    );
    await interaction.editReply({
      content: `確定字幕${String(exported.captionCount)}件をMarkdownで出力しました。`,
      files: [attachment],
      allowedMentions: { parse: [] },
    });
  }

  #validateExportThread(
    interaction: ChatInputCommandInteraction,
  ): PublicThreadChannel {
    const selected = interaction.options.getChannel(
      "thread",
      false,
      [ChannelType.PublicThread],
    );
    const thread = selected ?? interaction.channel;
    if (
      thread?.type !== ChannelType.PublicThread ||
      thread.guildId !== interaction.guildId
    ) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "対象には、このサーバーの公開スレッドを指定してください。",
      );
    }
    const actor = interaction.guild?.members.cache.get(interaction.user.id);
    const bot = interaction.guild?.members.me;
    if (!actor || !bot) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "対象スレッドの利用者またはBotの権限を確認できませんでした。",
      );
    }
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    // ThreadChannel#permissionsForは親Channelを解決できない場合、実行時にnullを返す。
    const actorPermissions = thread.permissionsFor(actor) as PermissionsBitField | null;
    if (!actorPermissions) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "対象スレッドの権限を確認できませんでした。",
      );
    }
    if (!requiredPermissions.every((permission) => actorPermissions.has(permission))) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "対象スレッドの閲覧権限とメッセージ履歴閲覧権限が必要です。",
      );
    }
    const botPermissions = thread.permissionsFor(bot) as PermissionsBitField | null;
    if (!botPermissions) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "Botの対象スレッドに対する権限を確認できませんでした。",
      );
    }
    if (!requiredPermissions.every((permission) => botPermissions.has(permission))) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "Botに対象スレッドの閲覧権限とメッセージ履歴閲覧権限がありません。",
      );
    }
    if (!interaction.appPermissions.has(PermissionFlagsBits.AttachFiles)) {
      throw new ApplicationError(
        "EXPORT_NOT_ALLOWED",
        "Botにファイル添付権限がありません。",
      );
    }
    return thread;
  }

  public async handleComponentInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    const registerListPage = /^register:list:(all|ja-ko|ja-en|ko-en):(\d+)$/u
      .exec(interaction.customId);
    const parsed = /^translate:([^:]+):(stop|toggle_audio|settings|playback_mode|caption_failure_policy)$/u
      .exec(interaction.customId);
    if (!registerListPage && !parsed) return;
    if (!this.#acceptingCommands) {
      await interaction.reply({
        content: "Botを停止中です。起動後に再実行してください。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (registerListPage) {
      await this.#handleRegisterListPage(interaction, registerListPage);
      return;
    }
    const sessionId = parsed?.[1];
    const action = parsed?.[2];
    if (!sessionId || !action) return;
    const actor = interaction.guild?.members.cache.get(interaction.user.id);
    const common = {
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
      actorCanManageGuild:
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
      actorVoiceChannelId: actor?.voice.channelId ?? undefined,
      sessionId,
    };

    if (action === "settings") {
      const result = await this.#commands.execute({
        kind: "control",
        action: "show_settings",
        ...common,
      });
      const session = interaction.guildId
        ? this.#commands.getSession(interaction.guildId)
        : undefined;
      if (!result.ok || session?.sessionId !== sessionId) {
        await interaction.reply({
          content: result.interactionMessage,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const settings = createSessionSettingsMessagePayload({
        sessionId,
        playbackMode: session.playbackMode,
        ttsSpeed: session.ttsSpeed,
        captionFailurePolicy: session.captionFailurePolicy,
      });
      await interaction.reply({
        ...settings,
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = action === "stop"
      ? await this.#commands.execute({ kind: "stop", ...common })
      : await this.#commands.execute({
          kind: "control",
          action: action === "toggle_audio"
            ? "toggle_audio"
            : action === "playback_mode"
              ? "set_playback_mode"
              : "set_caption_failure_policy",
          ...(interaction.isStringSelectMenu() && interaction.values[0] !== undefined
            ? { value: interaction.values[0] }
            : {}),
          ...common,
        });
    await interaction.editReply(result.interactionMessage);
  }

  async #handleRegisterListPage(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    parsed: RegExpExecArray,
  ): Promise<void> {
    const filterValue = parsed[1];
    const pageValue = parsed[2];
    if (
      !filterValue ||
      !pageValue ||
      (filterValue !== "all" && !isLanguagePair(filterValue))
    ) {
      return;
    }
    await interaction.deferUpdate();
    const result = await this.#commands.execute({
      kind: "register",
      action: "list",
      ...(filterValue === "all" ? {} : { pair: filterValue }),
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
    });
    if (!result.ok || result.registeredTerms === undefined) {
      await interaction.followUp({
        content: result.interactionMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const requestedPage = Number(pageValue);
    await interaction.editReply(createRegisteredTermListMessagePayload({
      terms: result.registeredTerms,
      filter: filterValue,
      requestedPage: Number.isSafeInteger(requestedPage) ? requestedPage : 0,
    }));
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
        await this.#commands.stopForFailure(guildId, "BOT_VOICE_REMOVED");
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
        return;
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
    await this.#commands.stopForFailure(guildId, reason);
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
    const mode = interaction.options.getString("mode");
    return {
      kind: "start" as const,
      pair: interaction.options.getString("pair", true),
      ...(mode === null ? {} : { mode }),
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
          createPublicThreads:
            textPermissions?.has(PermissionFlagsBits.CreatePublicThreads) ?? false,
          sendMessagesInThreads:
            textPermissions?.has(PermissionFlagsBits.SendMessagesInThreads) ?? false,
          manageThreads:
            textPermissions?.has(PermissionFlagsBits.ManageThreads) ?? false,
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

  #speedInput(interaction: ChatInputCommandInteraction) {
    const actor = interaction.guild?.members.cache.get(interaction.user.id);
    return {
      kind: "speed" as const,
      rate: interaction.options.getNumber("rate", true),
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
      actorCanManageGuild:
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
      actorVoiceChannelId: actor?.voice.channelId ?? undefined,
    };
  }

  #registerInput(interaction: ChatInputCommandInteraction): RegisterCommandInput {
    const common = {
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
    };
    const action = interaction.options.getSubcommand(true);
    if (action === "add") {
      return {
        kind: "register" as const,
        action,
        pair: interaction.options.getString("pair", true),
        source: interaction.options.getString("source", true),
        target: interaction.options.getString("target", true),
        ...common,
      };
    }
    if (action === "list") {
      const pair = interaction.options.getString("pair", false) ?? undefined;
      return {
        kind: "register" as const,
        action,
        ...(pair === undefined ? {} : { pair }),
        ...common,
      };
    }
    if (action === "delete") {
      return {
        kind: "register" as const,
        action,
        pair: interaction.options.getString("pair", true),
        source: interaction.options.getString("source", true),
        ...common,
      };
    }
    throw new Error("未対応のregisterサブコマンドです");
  }

  #languageInput(interaction: ChatInputCommandInteraction): LanguageCommandInput {
    const action = interaction.options.getSubcommand(true);
    const common = {
      kind: "language" as const,
      guildId: interaction.guildId ?? undefined,
      actorId: interaction.user.id,
      targetUserId:
        interaction.options.getUser("user", false)?.id ?? interaction.user.id,
    };
    if (action === "show") return { action, ...common };
    if (action === "set") {
      return {
        action,
        language: interaction.options.getString("language", true),
        ...common,
      };
    }
    throw new Error("未対応のlanguageサブコマンドです");
  }

  async #completeInteraction(
    interaction: ChatInputCommandInteraction,
    result: CommandResult,
  ): Promise<void> {
    await interaction.editReply(result.interactionMessage);
  }

  #guildLogId(guildId: string | null): string {
    return guildId ? this.#logger.pseudonymize(guildId) : "none";
  }
}

function truncateChoiceName(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 100
    ? value
    : `${characters.slice(0, 99).join("")}…`;
}
