import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChannelType,
  Collection,
  ComponentType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

import type {
  CommandResult,
  TranslationCommandInput,
} from "../src/commands/translation-command-service.js";
import { DiscordBotController } from "../src/discord/bot-controller.js";
import { createSafeLogger } from "../src/observability/logger.js";

function commands(inputLog: TranslationCommandInput[], result: CommandResult) {
  return {
    execute: (input: TranslationCommandInput) => {
      inputLog.push(input);
      return Promise.resolve(result);
    },
    getSession: () => undefined,
    handleVoiceParticipantsChanged: () => Promise.resolve({ stopped: false }),
    stopForFailure: () => Promise.resolve(false),
  };
}

function logger() {
  return createSafeLogger("0123456789abcdef0123456789abcdef", () => undefined);
}

void test("statusを認可サービスへ渡し、参加者名を含む状態をephemeral表示する", async () => {
  const inputs: TranslationCommandInput[] = [];
  const edits: unknown[] = [];
  const status = {
    sessionId: "session-1",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    voiceChannelName: "General",
    textChannelId: "text-1",
    textChannelName: "translation",
    startedByUserId: "user-1",
    pair: "ja-ko" as const,
    state: "ACTIVE" as const,
    startedAt: new Date("2026-08-21T03:00:00Z"),
    participantIds: ["user-1", "user-2"],
    playbackMode: "conversation" as const,
    audioEnabled: true,
    captionFailurePolicy: "continue_audio" as const,
    captionThreadId: "thread-1",
  };
  const controller = new DiscordBotController({
    client: { user: { id: "bot-1" } } as Client,
    commands: commands(inputs, {
      ok: true,
      ephemeral: true,
      interactionMessage: "現在の翻訳セッションを表示します。",
      status,
    }),
    logger: logger(),
    now: () => new Date("2026-08-21T03:01:00Z"),
  });
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "status",
    guildId: "guild-1",
    user: { id: "user-1" },
    guild: {
      members: {
        cache: new Map([
          ["user-1", { displayName: "Sota" }],
          ["user-2", { displayName: "민지" }],
        ]),
      },
    },
    deferReply: () => Promise.resolve(),
    editReply: (value: unknown) => {
      edits.push(value);
      return Promise.resolve();
    },
  } as unknown as ChatInputCommandInteraction;

  await controller.handleInteraction(interaction);

  assert.deepEqual(inputs, [{ kind: "status", guildId: "guild-1", actorId: "user-1" }]);
  assert.match(String(edits[0]), /状態: 翻訳中/u);
  assert.match(String(edits[0]), /参加者: Sota \/ 민지/u);
  assert.match(String(edits[0]), /字幕スレッド: <#thread-1>/u);
});

void test("registerの3引数を認可サービスへそのまま渡す", async () => {
  const inputs: TranslationCommandInput[] = [];
  const edits: unknown[] = [];
  const controller = new DiscordBotController({
    client: {} as Client,
    commands: commands(inputs, {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳用語を登録しました。",
    }),
    logger: logger(),
  });
  const values = new Map([
    ["pair", "ja-en"],
    ["source", "技術室"],
    ["target", "technology room"],
  ]);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "register",
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: (name: string) => values.get(name) },
    deferReply: () => Promise.resolve(),
    editReply: (value: unknown) => {
      edits.push(value);
      return Promise.resolve();
    },
  } as unknown as ChatInputCommandInteraction;

  await controller.handleInteraction(interaction);

  assert.deepEqual(inputs, [{
    kind: "register",
    pair: "ja-en",
    source: "技術室",
    target: "technology room",
    guildId: "guild-1",
    actorId: "user-1",
  }]);
  assert.deepEqual(edits, ["翻訳用語を登録しました。"]);
});

type ExportHarness = {
  controller: DiscordBotController;
  interaction: ChatInputCommandInteraction;
  inputs: TranslationCommandInput[];
  edits: unknown[];
  fetches: unknown[];
};

function createExportHarness(input: {
  actorMayRead?: boolean;
  botMayRead?: boolean;
  appMayAttach?: boolean;
  permissionsUnavailable?: boolean;
  attachmentSizeLimit?: number;
  useCurrentThread?: boolean;
} = {}): ExportHarness {
  const inputs: TranslationCommandInput[] = [];
  const edits: unknown[] = [];
  const fetches: unknown[] = [];
  const actor = { id: "user-1" };
  const bot = { id: "bot-1" };
  const thread = {
    id: "thread-1",
    guildId: "guild-1",
    name: "翻訳・日本語 ⇄ 韓国語",
    type: ChannelType.PublicThread,
    permissionsFor: (member: { id: string }) => input.permissionsUnavailable
      ? null
      : ({
          has: (permission: bigint) =>
            permission !== PermissionFlagsBits.ReadMessageHistory ||
            (member.id === actor.id
              ? input.actorMayRead !== false
              : input.botMayRead !== false),
        }),
    messages: {
      fetch: (options: unknown) => {
        fetches.push(options);
        return Promise.resolve(new Collection([["message-1", {
          id: "message-1",
          author: { id: "bot-1" },
          createdAt: new Date("2026-08-21T03:00:00Z"),
          components: [{
            toJSON: () => ({
              type: ComponentType.Container,
              components: [
                { type: ComponentType.TextDisplay, content: "**Sota** · `JA → KO`" },
                { type: ComponentType.TextDisplay, content: "**JA**\nこんにちは" },
                { type: ComponentType.TextDisplay, content: "**KO**\n안녕하세요" },
                { type: ComponentType.TextDisplay, content: "-# 🔊 再生済み" },
              ],
            }),
          }],
        }]]));
      },
    },
  };
  const controller = new DiscordBotController({
    client: { user: { id: "bot-1" } } as Client,
    commands: commands(inputs, {
      ok: true,
      ephemeral: true,
      interactionMessage: "翻訳スレッドをエクスポートします。",
    }),
    logger: logger(),
    now: () => new Date("2026-08-21T04:05:06Z"),
  });
  const interaction = {
    isChatInputCommand: () => true,
    commandName: "export",
    guildId: "guild-1",
    user: { id: "user-1" },
    guild: {
      members: {
        cache: new Map([["user-1", actor]]),
        me: bot,
      },
    },
    channel: input.useCurrentThread ? thread : { type: ChannelType.GuildText },
    options: { getChannel: () => input.useCurrentThread ? null : thread },
    appPermissions: { has: () => input.appMayAttach !== false },
    attachmentSizeLimit: input.attachmentSizeLimit ?? 1024 * 1024,
    deferReply: () => Promise.resolve(),
    editReply: (value: unknown) => {
      edits.push(value);
      return Promise.resolve();
    },
  } as unknown as ChatInputCommandInteraction;
  return { controller, interaction, inputs, edits, fetches };
}

void test("exportは認可後に対象Public Threadを読み、Markdown添付をephemeral返信する", async () => {
  const harness = createExportHarness();

  await harness.controller.handleInteraction(harness.interaction);

  assert.deepEqual(harness.inputs, [{ kind: "export", guildId: "guild-1", actorId: "user-1" }]);
  assert.deepEqual(harness.fetches, [{ limit: 100, cache: false }]);
  const reply = harness.edits[0] as {
    content: string;
    files: { name: string; attachment: Buffer }[];
  };
  assert.match(reply.content, /確定字幕1件/u);
  const file = reply.files[0];
  assert.ok(file);
  assert.equal(file.name, "translation-export-20260821-130506.md");
  assert.match(file.attachment.toString("utf8"), /こんにちは/u);
});

void test("thread引数を省略したexportはコマンドを実行したPublic Threadを使う", async () => {
  const harness = createExportHarness({ useCurrentThread: true });

  await harness.controller.handleInteraction(harness.interaction);

  assert.deepEqual(harness.fetches, [{ limit: 100, cache: false }]);
  assert.match(JSON.stringify(harness.edits[0]), /確定字幕1件/u);
});

void test("対象Threadを読めない実行者は履歴取得前に拒否する", async () => {
  const harness = createExportHarness({ actorMayRead: false });

  await harness.controller.handleInteraction(harness.interaction);

  assert.equal(harness.fetches.length, 0);
  assert.match(String(harness.edits[0]), /閲覧権限/u);
});

void test("対象Threadの権限を解決できなければ履歴取得前に明示的に拒否する", async () => {
  const harness = createExportHarness({ permissionsUnavailable: true });

  await harness.controller.handleInteraction(harness.interaction);

  assert.equal(harness.fetches.length, 0);
  assert.match(String(harness.edits[0]), /権限を確認できません/u);
});

void test("Botの履歴閲覧権限またはファイル添付権限がなければ履歴を取得しない", async () => {
  const noHistory = createExportHarness({ botMayRead: false });
  const noAttachment = createExportHarness({ appMayAttach: false });

  await noHistory.controller.handleInteraction(noHistory.interaction);
  await noAttachment.controller.handleInteraction(noAttachment.interaction);

  assert.equal(noHistory.fetches.length, 0);
  assert.equal(noAttachment.fetches.length, 0);
  assert.match(String(noHistory.edits[0]), /Botに対象スレッドの閲覧権限/u);
  assert.match(String(noAttachment.edits[0]), /ファイル添付権限/u);
});

void test("MarkdownがDiscordの添付上限を超える場合は切り詰めず拒否する", async () => {
  const harness = createExportHarness({ attachmentSizeLimit: 10 });

  await harness.controller.handleInteraction(harness.interaction);

  assert.match(String(harness.edits[0]), /添付できるサイズ上限/u);
});
