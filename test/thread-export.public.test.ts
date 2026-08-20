import assert from "node:assert/strict";
import { test } from "node:test";

import { Collection, ComponentType } from "discord.js";

import { ApplicationError } from "../src/domain/application-error.js";
import {
  exportThreadToMarkdown,
  type ExportableThread,
} from "../src/discord/thread-export.js";

type ExportMessage = {
  id: string;
  author: { id: string };
  createdAt: Date;
  components: { toJSON(): unknown }[];
};

function captionMessage(
  id: string,
  original: string,
  translated: string,
  createdAt: Date,
  status = "-# 🔊 再生済み",
): ExportMessage {
  return {
    id,
    author: { id: "bot-user" },
    createdAt,
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: "**Sota** · `JA → KO`" },
          { type: ComponentType.Separator },
          { type: ComponentType.TextDisplay, content: `**JA**\n${original}` },
          { type: ComponentType.Separator },
          { type: ComponentType.TextDisplay, content: `**KO**\n${translated}` },
          { type: ComponentType.TextDisplay, content: status },
        ],
      }),
    }],
  };
}

function nonCaptionMessage(id: string, authorId = "bot-user"): ExportMessage {
  return {
    id,
    author: { id: authorId },
    createdAt: new Date("2026-08-21T03:00:00Z"),
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [{
          type: ComponentType.TextDisplay,
          content: "**⏹ 翻訳を終了しました**",
        }],
      }),
    }],
  };
}

void test("Discord履歴を100件ずつ取得し、Botの確定字幕だけを時系列Markdownへ出力する", async () => {
  const fetches: unknown[] = [];
  const newestPage = new Collection<string, ExportMessage>();
  newestPage.set("200", captionMessage(
    "200",
    "二番目",
    "두 번째",
    new Date("2026-08-21T03:02:00Z"),
  ));
  for (let index = 199; index >= 101; index -= 1) {
    newestPage.set(String(index), nonCaptionMessage(String(index), "human-user"));
  }
  const oldestPage = new Collection<string, ExportMessage>();
  oldestPage.set("100", captionMessage(
    "100",
    "一番目",
    "첫 번째",
    new Date("2026-08-21T03:01:00Z"),
  ));
  oldestPage.set("99", nonCaptionMessage("99"));
  oldestPage.set("98", captionMessage(
    "98",
    "処理中",
    "처리 중",
    new Date("2026-08-21T03:00:30Z"),
    "-# ⏳ 再生待ち",
  ));
  const pages = [newestPage, oldestPage];
  const thread = {
    id: "thread-1",
    name: "翻訳・日本語 ⇄ 韓国語",
    messages: {
      fetch: (options: unknown) => {
        fetches.push(options);
        return Promise.resolve(pages.shift() ?? new Collection());
      },
    },
  } as ExportableThread;

  const result = await exportThreadToMarkdown({
    thread,
    botUserId: "bot-user",
    now: () => new Date("2026-08-21T04:05:06Z"),
  });

  assert.equal(result.captionCount, 2);
  assert.equal(result.filename, "translation-export-20260821-130506.md");
  assert.equal(fetches.length, 2);
  assert.deepEqual(fetches, [
    { limit: 100, cache: false },
    { limit: 100, cache: false, before: "101" },
  ]);
  assert.ok(result.markdown.indexOf("一番目") < result.markdown.indexOf("二番目"));
  assert.match(result.markdown, /\*\*Sota\*\* · `JA → KO`/u);
  assert.doesNotMatch(result.markdown, /翻訳を終了しました/u);
  assert.doesNotMatch(result.markdown, /再生済み/u);
  assert.doesNotMatch(result.markdown, /処理中/u);
  assert.equal(result.byteLength, Buffer.byteLength(result.markdown, "utf8"));
});

void test("確定字幕がないスレッドは空ファイルを返さず明示的に拒否する", async () => {
  const thread = {
    id: "thread-1",
    name: "一般スレッド",
    messages: {
      fetch: () => Promise.resolve(new Collection([
        ["1", nonCaptionMessage("1", "human-user")],
      ])),
    },
  } as ExportableThread;

  await assert.rejects(
    exportThreadToMarkdown({ thread, botUserId: "bot-user" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "EXPORT_EMPTY",
  );
});
