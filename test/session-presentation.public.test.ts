import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComponentType,
  ThreadAutoArchiveDuration,
} from "discord.js";

import {
  DiscordCaptionGateway,
} from "../src/discord/caption-gateway.js";
import {
  DiscordSessionPresentation,
  type SessionCardPayload,
} from "../src/discord/session-presentation.js";

type SerializedComponent = {
  type: ComponentType;
  content?: string;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  components?: SerializedComponent[];
};

function serialized(payload: SessionCardPayload): SerializedComponent[] {
  const visit = (component: SerializedComponent): SerializedComponent[] => [
    component,
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return payload.components.flatMap((component) =>
    visit(component.toJSON() as SerializedComponent));
}

function contents(payload: SessionCardPayload): string[] {
  const visit = (component: SerializedComponent): string[] => [
    ...(component.type === ComponentType.TextDisplay && component.content
      ? [component.content]
      : []),
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return payload.components.flatMap((component) =>
    visit(component.toJSON() as SerializedComponent));
}

function after(delayMs: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), delayMs);
  });
}

void test("親カードから専用スレッドを作り、状態更新後に終了表示してアーカイブする", async () => {
  const cards: SessionCardPayload[] = [];
  const threadMessages: SessionCardPayload[] = [];
  const archiveValues: boolean[] = [];
  const events: string[] = [];
  const thread = {
    id: "thread-1",
    send(payload: SessionCardPayload) {
      events.push("thread-message");
      threadMessages.push(payload);
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      });
    },
    setArchived(value: boolean) {
      events.push("archive");
      archiveValues.push(value);
      return Promise.resolve();
    },
  };
  const message = {
    edit(payload: SessionCardPayload) {
      events.push("card-edit");
      cards.push(payload);
      return Promise.resolve();
    },
    startThread(options: { name: string; autoArchiveDuration: number }) {
      events.push("start-thread");
      assert.match(options.name, /日本語.*韓国語/u);
      assert.equal(options.autoArchiveDuration, ThreadAutoArchiveDuration.OneHour);
      return Promise.resolve(thread);
    },
  };
  const parent = {
    send(payload: SessionCardPayload) {
      events.push("card-send");
      cards.push(payload);
      return Promise.resolve(message);
    },
  };

  const presentation = await DiscordSessionPresentation.open({
    channel: parent,
    sessionId: "session-1",
    pair: "ja-ko",
    participantDisplayNames: ["Sota", "민지"],
    playbackMode: "conversation",
    ttsSpeed: 1.15,
    audioEnabled: true,
    queueWarningMs: 2_500,
    startedAt: new Date("2026-08-19T00:00:00Z"),
    now: () => new Date("2026-08-19T00:12:34Z"),
  });

  assert.equal(presentation.captionChannel, thread);
  assert.equal(presentation.threadId, "thread-1");
  assert.deepEqual(events.slice(0, 2), ["card-send", "start-thread"]);
  const initialCard = cards[0];
  assert.ok(initialCard);
  assert.deepEqual(contents(initialCard), [
    "**🟢 翻訳中**",
    "日本語 ⇄ 韓国語\n参加者: Sota / 민지\n経過時間: 12:34\n現在の音声待ち: 0.0秒\nモード: 会話優先\n読み上げ速度: 1.15倍",
  ]);
  const buttons = serialized(initialCard)
    .filter((component) => component.type === ComponentType.Button);
  assert.deepEqual(buttons.map((button) => button.label), [
    "停止",
    "字幕のみへ変更",
    "設定",
  ]);
  assert.ok(buttons.every((button) => button.custom_id?.includes("session-1")));

  await presentation.update({
    participantDisplayNames: ["Sota", "민지"],
    playbackMode: "accuracy",
    ttsSpeed: 1.3,
    audioEnabled: false,
    queueWaitMs: 5_200,
  });
  const updatedCard = cards.at(-1);
  assert.ok(updatedCard);
  assert.match(contents(updatedCard).join("\n"), /正確さ優先/u);
  assert.match(contents(updatedCard).join("\n"), /読み上げ速度: 1\.3倍/u);
  assert.match(contents(updatedCard).join("\n"), /5\.2秒/u);
  assert.match(
    contents(updatedCard).join("\n"),
    /⚠ 翻訳音声が5\.2秒遅れています/u,
  );
  const updatedButtons = serialized(updatedCard)
    .filter((component) => component.type === ComponentType.Button);
  assert.equal(updatedButtons[1]?.label, "音声へ戻す");

  await presentation.close("USER_REQUEST");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(archiveValues, [true]);
  assert.deepEqual(events.slice(-3), ["thread-message", "card-edit", "archive"]);
  const stopMessage = threadMessages[0];
  const finalCard = cards.at(-1);
  assert.ok(stopMessage);
  assert.ok(finalCard);
  assert.match(contents(stopMessage).join("\n"), /翻訳を終了/u);
  const finalButtons = serialized(finalCard)
    .filter((component) => component.type === ComponentType.Button);
  assert.ok(finalButtons.every((button) => button.disabled));
});

void test("Discordのカード更新や終了通知が未完了でも停止要求は直ちに完了する", async () => {
  let blockCardUpdate = true;
  const pendingCardUpdate = new Promise<never>(() => undefined);
  const thread = {
    id: "thread-pending-card",
    send: () => Promise.resolve({
      edit: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }),
    setArchived: () => Promise.resolve(),
  };
  const message = {
    edit: () => blockCardUpdate ? pendingCardUpdate : Promise.resolve(),
    startThread: () => Promise.resolve(thread),
  };
  const presentation = await DiscordSessionPresentation.open({
    channel: { send: () => Promise.resolve(message) },
    sessionId: "session-pending-card",
    pair: "ja-ko",
    participantDisplayNames: ["Sota"],
    playbackMode: "conversation",
    ttsSpeed: 1.15,
    audioEnabled: true,
    queueWarningMs: 2_500,
    startedAt: new Date("2026-08-19T00:00:00Z"),
  });
  void presentation.update({
    participantDisplayNames: ["Sota"],
    playbackMode: "conversation",
    ttsSpeed: 1.15,
    audioEnabled: true,
    queueWaitMs: 0,
  });

  assert.equal(
    await Promise.race([
      presentation.close("USER_REQUEST").then(() => "closed" as const),
      after(20),
    ]),
    "closed",
  );

  blockCardUpdate = false;
  const pendingStopNotice = new Promise<never>(() => undefined);
  const secondPresentation = await DiscordSessionPresentation.open({
    channel: {
      send: () => Promise.resolve({
        edit: () => Promise.resolve(),
        startThread: () => Promise.resolve({
          id: "thread-pending-stop-notice",
          send: () => pendingStopNotice,
          setArchived: () => Promise.resolve(),
        }),
      }),
    },
    sessionId: "session-pending-stop-notice",
    pair: "ja-ko",
    participantDisplayNames: ["Sota"],
    playbackMode: "conversation",
    ttsSpeed: 1.15,
    audioEnabled: true,
    queueWarningMs: 2_500,
    startedAt: new Date("2026-08-19T00:00:00Z"),
  });

  assert.equal(
    await Promise.race([
      secondPresentation.close("USER_REQUEST").then(() => "closed" as const),
      after(20),
    ]),
    "closed",
  );
});

void test("停止前の遅い字幕POSTが完了してスレッドを再開しても再度アーカイブする", async () => {
  let resolveCaptionSend: ((message: {
    edit: () => Promise<void>;
    delete: () => Promise<void>;
  }) => void) | undefined;
  const pendingCaptionSend = new Promise<{
    edit: () => Promise<void>;
    delete: () => Promise<void>;
  }>((resolve) => {
    resolveCaptionSend = resolve;
  });
  const archiveValues: boolean[] = [];
  let threadSendCount = 0;
  const thread = {
    id: "thread-late-caption",
    send() {
      threadSendCount += 1;
      return threadSendCount === 1
        ? pendingCaptionSend
        : Promise.resolve({
            edit: () => Promise.resolve(),
            delete: () => Promise.resolve(),
          });
    },
    setArchived(value: boolean) {
      archiveValues.push(value);
      return Promise.resolve();
    },
  };
  const presentation = await DiscordSessionPresentation.open({
    channel: {
      send: () => Promise.resolve({
        edit: () => Promise.resolve(),
        startThread: () => Promise.resolve(thread),
      }),
    },
    sessionId: "session-late-caption",
    pair: "ja-ko",
    participantDisplayNames: ["Sota"],
    playbackMode: "conversation",
    ttsSpeed: 1.15,
    audioEnabled: true,
    queueWarningMs: 2_500,
    startedAt: new Date("2026-08-19T00:00:00Z"),
  });
  const captions = new DiscordCaptionGateway(presentation.captionChannel, {
    onClosedOperationSettled: () => presentation.rearchiveAfterClose(),
  });
  const captionPost = captions.post({
    utteranceId: "u-late",
    sessionId: "session-late-caption",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "こんにちは",
    translatedText: "안녕하세요",
    sourceDurationMs: 500,
    state: "pending",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await captions.close();
  await presentation.close("USER_REQUEST");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(archiveValues, [true]);

  assert.ok(resolveCaptionSend);
  resolveCaptionSend({
    edit: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  });
  assert.equal(await captionPost, undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(archiveValues, [true, true]);
});
