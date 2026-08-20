import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChannelType,
} from "discord.js";

import {
  exportCommand,
  registerCommand,
  statusCommand,
  translateCommand,
} from "../src/discord/command-definition.js";

void test("translateコマンドはGuild専用で既定権限なし、言語ペアは選択肢だけを受け付ける", () => {
  const json = translateCommand.toJSON();

  assert.equal(json.name, "translate");
  assert.deepEqual(json.contexts, [0]);
  assert.equal(json.default_member_permissions, "0");

  const start = json.options?.find((option) => option.name === "start");
  const stop = json.options?.find((option) => option.name === "stop");
  assert.ok(start);
  assert.ok(stop);
  assert.equal(start.type, 1);
  assert.equal(stop.type, 1);

  const pair = "options" in start
    ? start.options?.find((option) => option.name === "pair")
    : undefined;
  assert.ok(pair);
  assert.equal(pair.required, true);
  assert.deepEqual(
    "choices" in pair ? pair.choices?.map((choice) => [choice.name, choice.value]) : [],
    [
      ["日本語 ⇄ 韓国語", "ja-ko"],
      ["日本語 ⇄ 英語", "ja-en"],
      ["韓国語 ⇄ 英語", "ko-en"],
    ],
  );

  const mode = "options" in start
    ? start.options?.find((option) => option.name === "mode")
    : undefined;
  assert.ok(mode);
  assert.equal(mode.required, false);
  assert.deepEqual(
    "choices" in mode ? mode.choices?.map((choice) => [choice.name, choice.value]) : [],
    [
      ["会話優先", "conversation"],
      ["正確さ優先", "accuracy"],
    ],
  );
});

void test("status・export・registerはGuild全員へ表示し、必要な引数だけを公開する", () => {
  const status = statusCommand.toJSON();
  const exportJson = exportCommand.toJSON();
  const register = registerCommand.toJSON();

  for (const command of [status, exportJson, register]) {
    assert.deepEqual(command.contexts, [0]);
    assert.equal(command.default_member_permissions, undefined);
  }
  assert.equal(status.name, "status");
  assert.deepEqual(status.options ?? [], []);

  assert.equal(exportJson.name, "export");
  const thread = exportJson.options?.find((option) => option.name === "thread");
  assert.ok(thread);
  assert.equal(thread.required, false);
  assert.deepEqual("channel_types" in thread ? thread.channel_types : [], [
    ChannelType.PublicThread,
  ]);

  assert.equal(register.name, "register");
  const pair = register.options?.find((option) => option.name === "pair");
  const source = register.options?.find((option) => option.name === "source");
  const target = register.options?.find((option) => option.name === "target");
  assert.ok(pair);
  assert.ok(source);
  assert.ok(target);
  assert.equal(pair.required, true);
  assert.equal(source.required, true);
  assert.equal(target.required, true);
  assert.deepEqual(
    "choices" in pair ? pair.choices?.map((choice) => [choice.name, choice.value]) : [],
    [
      ["日本語 ⇄ 韓国語", "ja-ko"],
      ["日本語 ⇄ 英語", "ja-en"],
      ["韓国語 ⇄ 英語", "ko-en"],
    ],
  );
});
