import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { validEnv } from "./helpers/valid-env.js";

void test("有効な環境変数を型付き設定と固定リージョンURLへ変換する", () => {
  const config = loadConfig(validEnv(), new Date("2026-08-15T00:00:00Z"));

  assert.equal(config.soniox.region, "us");
  assert.equal(config.soniox.restBaseUrl, "https://api.soniox.com");
  assert.equal(config.soniox.sttWebSocketUrl, "wss://stt-rt.soniox.com/transcribe-websocket");
  assert.equal(config.soniox.ttsWebSocketUrl, "wss://tts-rt.soniox.com/text-to-speech-websocket");
  assert.deepEqual([...config.discord.allowedGuildIds], ["223456789012345678"]);
  assert.equal(config.limits.maxSpeakersPerSession, 2);
  assert.equal(config.pricing.safetyPercent, 125);
});

void test("不正な設定を一括報告し、秘密値はエラーへ含めない", () => {
  const leakedToken = "do-not-leak-this-discord-token";
  const leakedKey = "do-not-leak-this-soniox-key";
  const env = validEnv({
    DISCORD_TOKEN: leakedToken,
    SONIOX_API_KEY: leakedKey,
    ALLOWED_GUILD_IDS: "not-a-snowflake",
    MAX_SPEAKERS_PER_SESSION: "3",
    GLOBAL_MONTHLY_COST_LIMIT_MICROUSD: "2000000",
    SQLITE_PATH: "relative.sqlite",
    SONIOX_REGION: "america",
  });

  assert.throws(
    () => loadConfig(env, new Date("2026-08-15T00:00:00Z")),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ALLOWED_GUILD_IDS/);
      assert.match(error.message, /MAX_SPEAKERS_PER_SESSION/);
      assert.match(error.message, /GLOBAL_MONTHLY_COST_LIMIT_MICROUSD/);
      assert.match(error.message, /SQLITE_PATH/);
      assert.match(error.message, /SONIOX_REGION/);
      assert.doesNotMatch(error.message, new RegExp(leakedToken));
      assert.doesNotMatch(error.message, new RegExp(leakedKey));
      return true;
    },
  );
});

void test("料金確認日が期限切れなら起動設定を拒否する", () => {
  const env = validEnv({
    PRICING_CONFIRMED_AT: "2026-07-01",
    PRICING_MAX_AGE_DAYS: "30",
  });

  assert.throws(
    () => loadConfig(env, new Date("2026-08-15T00:00:00Z")),
    /PRICING_CONFIRMED_AT/,
  );
});
