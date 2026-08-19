import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChannelType,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

import type { CommandResult } from "../src/commands/translation-command-service.js";
import { DiscordBotController } from "../src/discord/bot-controller.js";
import { createSafeLogger } from "../src/observability/logger.js";

type SentPayload = {
  content?: string;
  components?: { toJSON(): SerializedComponent }[];
  flags?: number;
  allowedMentions: { parse: [] };
};

type SerializedComponent = {
  type: ComponentType;
  content?: string;
  components?: SerializedComponent[];
};

function textContents(payload: SentPayload): string[] {
  const visit = (component: SerializedComponent): string[] => [
    ...(component.type === ComponentType.TextDisplay && component.content
      ? [component.content]
      : []),
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return payload.components?.flatMap((component) => visit(component.toJSON())) ?? [];
}

function createHarness(options: { publicSendFails?: boolean } = {}) {
  const events: string[] = [];
  const sent: SentPayload[] = [];
  const stopped: string[] = [];
  const result: CommandResult = {
    ok: true,
    ephemeral: true,
    interactionMessage: "翻訳を開始しました。",
    publicMessage: {
      channelId: "623456789012345678",
      content: "通常の開始通知",
    },
  };
  const commands = {
    execute: (): Promise<CommandResult> => {
      events.push("execute");
      return Promise.resolve(result);
    },
    getSession: () => undefined,
    handleVoiceParticipantsChanged: () => Promise.resolve({ stopped: false }),
    stopForFailure: (_guildId: string, reason: string): Promise<boolean> => {
      stopped.push(reason);
      return Promise.resolve(true);
    },
  };
  const client = {
    user: { id: "723456789012345678" },
    channels: {
      fetch: (): Promise<{
        isTextBased(): true;
        send(payload: SentPayload): Promise<void>;
      }> => Promise.resolve({
        isTextBased: () => true,
        send: (payload) => {
          events.push("public");
          if (options.publicSendFails) return Promise.reject(new Error("missing permission"));
          sent.push(payload);
          return Promise.resolve();
        },
      }),
    },
  } as unknown as Client;
  const permissionSet = { has: () => true };
  const members = new Map([
    [
      "323456789012345678",
      {
        id: "323456789012345678",
        user: { bot: false },
        voice: { channelId: "523456789012345678" },
      },
    ],
    [
      "423456789012345678",
      {
        id: "423456789012345678",
        user: { bot: false },
        voice: { channelId: "523456789012345678" },
      },
    ],
  ]);
  const voiceChannel = {
    id: "523456789012345678",
    name: "General",
    members,
    permissionsFor: () => permissionSet,
  };
  for (const member of members.values()) {
    member.voice = { ...member.voice, channel: voiceChannel } as typeof member.voice;
  }
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "translate",
    guildId: "223456789012345678",
    user: { id: "323456789012345678" },
    memberPermissions: permissionSet,
    guild: {
      members: {
        cache: members,
        me: { id: "723456789012345678" },
      },
    },
    channel: {
      type: ChannelType.GuildText,
      id: "623456789012345678",
      name: "translation",
      permissionsFor: () => permissionSet,
    },
    options: {
      getSubcommand: () => "start",
      getString: () => "ja-ko",
    },
    deferReply: (): Promise<void> => {
      events.push("defer");
      return Promise.resolve();
    },
    editReply: (content: string): Promise<void> => {
      events.push(`edit:${content}`);
      return Promise.resolve();
    },
  } as unknown as ChatInputCommandInteraction;
  const logger = createSafeLogger("0123456789abcdef0123456789abcdef", () => undefined);
  const controller = new DiscordBotController({ client, commands, logger });
  return { controller, interaction, events, sent, stopped };
}

void test("Discordへ先にephemeral ACKし、Driverが作成したセッションカードを二重投稿しない", async () => {
  const harness = createHarness();

  await harness.controller.handleInteraction(harness.interaction);

  assert.deepEqual(harness.events, [
    "defer",
    "execute",
    "edit:翻訳を開始しました。",
  ]);
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.stopped, []);
});

void test("Controllerは親チャンネルへ開始通知を投稿せず、Driverの開始結果だけを返す", async () => {
  const harness = createHarness({ publicSendFails: true });

  await harness.controller.handleInteraction(harness.interaction);

  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.events.includes("public"), false);
  assert.match(harness.events.at(-1) ?? "", /翻訳を開始しました/u);
});

void test("実行時失敗ではRuntimeのセッションカード終了処理に任せ、親へ通知を追加投稿しない", async () => {
  const stopReasons: string[] = [];
  const session = {
    sessionId: "session-1",
    guildId: "223456789012345678",
    voiceChannelId: "523456789012345678",
    voiceChannelName: "General",
    textChannelId: "623456789012345678",
    textChannelName: "translation",
    startedByUserId: "323456789012345678",
    pair: "ja-ko" as const,
    state: "ACTIVE" as const,
    startedAt: new Date("2026-08-16T00:00:00Z"),
    participantIds: ["323456789012345678"],
    playbackMode: "conversation" as const,
    audioEnabled: true,
    captionFailurePolicy: "continue_audio" as const,
  };
  const client = {} as Client;
  const controller = new DiscordBotController({
    client,
    commands: {
      execute: () => Promise.resolve({
        ok: false,
        ephemeral: true,
        interactionMessage: "",
      }),
      getSession: () => session,
      handleVoiceParticipantsChanged: () => Promise.resolve({ stopped: false }),
      stopForFailure: (_guildId, reason) => {
        stopReasons.push(reason);
        return Promise.resolve(true);
      },
    },
    logger: createSafeLogger(
      "0123456789abcdef0123456789abcdef",
      () => undefined,
    ),
  });

  await controller.handleRuntimeFailure(
    session.guildId,
    "SESSION_IDLE",
    "無音時間の上限へ達したため翻訳を停止します。",
  );

  assert.deepEqual(stopReasons, ["SESSION_IDLE"]);
});

void test("セッションカードの設定ボタンを同じ認可経路へ渡し、現在値入り選択メニューをephemeral表示する", async () => {
  const executions: unknown[] = [];
  const replies: SentPayload[] = [];
  const session = {
    sessionId: "session-1",
    guildId: "223456789012345678",
    voiceChannelId: "523456789012345678",
    voiceChannelName: "General",
    textChannelId: "623456789012345678",
    textChannelName: "translation",
    startedByUserId: "323456789012345678",
    pair: "ja-ko" as const,
    state: "ACTIVE" as const,
    startedAt: new Date("2026-08-19T00:00:00Z"),
    participantIds: ["323456789012345678"],
    playbackMode: "conversation" as const,
    audioEnabled: true,
    captionFailurePolicy: "continue_audio" as const,
  };
  const controller = new DiscordBotController({
    client: {} as Client,
    commands: {
      execute: (input) => {
        executions.push(input);
        return Promise.resolve({
          ok: true,
          ephemeral: true,
          interactionMessage: "セッション設定を表示します。",
        });
      },
      getSession: () => session,
      handleVoiceParticipantsChanged: () => Promise.resolve({ stopped: false }),
      stopForFailure: () => Promise.resolve(false),
    },
    logger: createSafeLogger(
      "0123456789abcdef0123456789abcdef",
      () => undefined,
    ),
  });
  const interaction = {
    customId: "translate:session-1:settings",
    guildId: session.guildId,
    user: { id: session.startedByUserId },
    memberPermissions: { has: () => false },
    guild: {
      members: {
        cache: new Map([[session.startedByUserId, {
          voice: { channelId: session.voiceChannelId },
        }]]),
      },
    },
    reply: (payload: SentPayload) => {
      replies.push(payload);
      return Promise.resolve();
    },
  } as unknown as ButtonInteraction;

  await controller.handleComponentInteraction(interaction);

  assert.deepEqual(executions, [{
    kind: "control",
    action: "show_settings",
    guildId: session.guildId,
    actorId: session.startedByUserId,
    actorCanManageGuild: false,
    actorVoiceChannelId: session.voiceChannelId,
    sessionId: session.sessionId,
  }]);
  const reply = replies[0];
  assert.ok(reply);
  assert.equal(
    reply.flags,
    MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  );
  assert.match(textContents(reply).join("\n"), /セッション設定/u);
  assert.match(JSON.stringify(reply), /playback_mode/u);
  assert.match(JSON.stringify(reply), /caption_failure_policy/u);
});

void test("CONNECTING中の音声参加者変更も認可検査へ渡す", async () => {
  const participants: string[][] = [];
  const voiceChannel = {
    type: ChannelType.GuildVoice,
    members: new Map([
      [
        "999999999999999999",
        { id: "999999999999999999", user: { bot: false } },
      ],
    ]),
  };
  const guild = {
    id: "223456789012345678",
    channels: {
      cache: new Map([["523456789012345678", voiceChannel]]),
    },
  };
  const commands = {
    execute: (): Promise<CommandResult> => Promise.resolve({
      ok: false,
      ephemeral: true,
      interactionMessage: "",
    }),
    getSession: () => ({
      sessionId: "session-1",
      guildId: guild.id,
      voiceChannelId: "523456789012345678",
      voiceChannelName: "General",
      textChannelId: "623456789012345678",
      textChannelName: "translation",
      startedByUserId: "323456789012345678",
      pair: "ja-ko" as const,
      state: "CONNECTING" as const,
      startedAt: new Date("2026-08-16T00:00:00Z"),
      participantIds: ["323456789012345678"],
      playbackMode: "conversation" as const,
      audioEnabled: true,
      captionFailurePolicy: "continue_audio" as const,
    }),
    handleVoiceParticipantsChanged: (
      _guildId: string,
      participantIds: readonly string[],
    ) => {
      participants.push([...participantIds]);
      return Promise.resolve({ stopped: false });
    },
    stopForFailure: () => Promise.resolve(false),
  };
  const controller = new DiscordBotController({
    client: { user: { id: "723456789012345678" } } as unknown as Client,
    commands,
    logger: createSafeLogger(
      "0123456789abcdef0123456789abcdef",
      () => undefined,
    ),
  });

  await controller.handleVoiceStateUpdate(
    {
      id: "999999999999999999",
      channelId: null,
      guild,
    } as never,
    {
      id: "999999999999999999",
      channelId: "523456789012345678",
      guild,
    } as never,
  );

  assert.deepEqual(participants, [["999999999999999999"]]);
});

void test("構造化ログはDiscord IDと例外メッセージをそのまま出力しない", () => {
  const lines: string[] = [];
  const logger = createSafeLogger(
    "0123456789abcdef0123456789abcdef",
    (line) => lines.push(line),
  );
  const rawId = "223456789012345678";

  logger.error("test_failure", new Error("secret-like body"), {
    guild_id: logger.pseudonymize(rawId),
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", new RegExp(rawId));
  assert.doesNotMatch(lines[0] ?? "", /secret-like body/u);
  assert.match(lines[0] ?? "", /"error_name":"Error"/u);
});
