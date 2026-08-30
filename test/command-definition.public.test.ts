import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChannelType,
} from "discord.js";

import {
  exportCommand,
  guildCommands,
  languageCommand,
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
  const speed = json.options?.find((option) => option.name === "speed");
  assert.ok(start);
  assert.ok(stop);
  assert.ok(speed);
  assert.equal(start.type, 1);
  assert.equal(stop.type, 1);
  assert.equal(speed.type, 1);

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

  const rate = "options" in speed
    ? speed.options?.find((option) => option.name === "rate")
    : undefined;
  assert.ok(rate);
  assert.equal(rate.required, true);
  assert.equal("min_value" in rate ? rate.min_value : undefined, 0.7);
  assert.equal("max_value" in rate ? rate.max_value : undefined, 1.3);
});

void test("languageは本人を既定対象にし、言語コードを手入力させない", () => {
  const language = languageCommand.toJSON();

  assert.equal(language.name, "language");
  assert.deepEqual(language.contexts, [0]);
  assert.equal(language.default_member_permissions, undefined);

  const show = language.options?.find((option) => option.name === "show");
  const set = language.options?.find((option) => option.name === "set");
  assert.ok(show);
  assert.ok(set);
  assert.equal(show.type, 1);
  assert.equal(set.type, 1);

  const showUser = "options" in show
    ? show.options?.find((option) => option.name === "user")
    : undefined;
  const setUser = "options" in set
    ? set.options?.find((option) => option.name === "user")
    : undefined;
  const setting = "options" in set
    ? set.options?.find((option) => option.name === "language")
    : undefined;
  assert.ok(showUser);
  assert.ok(setUser);
  assert.ok(setting);
  assert.equal(showUser.required, false);
  assert.equal(setUser.required, false);
  assert.equal(setting.required, true);
  assert.deepEqual(
    "choices" in setting
      ? setting.choices?.map((choice) => [choice.name, choice.value])
      : [],
    [
      ["自動判定", "auto"],
      ["日本語", "ja"],
      ["韓国語", "ko"],
      ["英語", "en"],
    ],
  );
});

void test("Guild登録対象はlanguageを含む全コマンドを1つの一覧から生成する", () => {
  assert.deepEqual(
    guildCommands.map((command) => command.toJSON().name),
    ["translate", "status", "export", "register", "language"],
  );
});

void test("status・export・registerはGuild全員へ表示し、用語管理を3サブコマンドで公開する", () => {
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
  const add = register.options?.find((option) => option.name === "add");
  const list = register.options?.find((option) => option.name === "list");
  const remove = register.options?.find((option) => option.name === "delete");
  assert.ok(add);
  assert.ok(list);
  assert.ok(remove);
  assert.equal(add.type, 1);
  assert.equal(list.type, 1);
  assert.equal(remove.type, 1);

  const pair = "options" in add
    ? add.options?.find((option) => option.name === "pair")
    : undefined;
  const source = "options" in add
    ? add.options?.find((option) => option.name === "source")
    : undefined;
  const target = "options" in add
    ? add.options?.find((option) => option.name === "target")
    : undefined;
  assert.ok(pair);
  assert.ok(source);
  assert.ok(target);
  assert.equal(pair.required, true);
  assert.equal(source.required, true);
  assert.equal(target.required, true);
  assert.equal("max_length" in source ? source.max_length : undefined, 100);
  assert.equal("max_length" in target ? target.max_length : undefined, 100);
  assert.deepEqual(
    "choices" in pair ? pair.choices?.map((choice) => [choice.name, choice.value]) : [],
    [
      ["日本語 ⇄ 韓国語", "ja-ko"],
      ["日本語 ⇄ 英語", "ja-en"],
      ["韓国語 ⇄ 英語", "ko-en"],
    ],
  );

  const listPair = "options" in list
    ? list.options?.find((option) => option.name === "pair")
    : undefined;
  assert.ok(listPair);
  assert.equal(listPair.required, false);

  const deletePair = "options" in remove
    ? remove.options?.find((option) => option.name === "pair")
    : undefined;
  const deleteSource = "options" in remove
    ? remove.options?.find((option) => option.name === "source")
    : undefined;
  assert.ok(deletePair);
  assert.ok(deleteSource);
  assert.equal(deletePair.required, true);
  assert.equal(deleteSource.required, true);
  assert.equal("autocomplete" in deleteSource ? deleteSource.autocomplete : undefined, true);
});
