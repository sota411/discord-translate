import assert from "node:assert/strict";
import { test } from "node:test";

import { translateCommand } from "../src/discord/command-definition.js";

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
    "choices" in pair ? pair.choices?.map((choice) => choice.value) : [],
    ["ja-ko", "ja-en", "ko-en"],
  );
});
