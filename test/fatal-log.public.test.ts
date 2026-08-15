import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError } from "../src/config.js";
import { createFatalLogRecord } from "../src/observability/fatal-log.js";

void test("起動設定エラーは秘密値を含めず設定名と理由をログへ出す", () => {
  const record = createFatalLogRecord(
    "application_start_failed",
    new ConfigError([
      "ALLOWED_GUILD_IDS: 値が必要です",
      "SONIOX_VOICE_JA: 値が必要です",
    ]),
    new Date("2026-08-15T13:00:00Z"),
  );

  assert.deepEqual(record, {
    timestamp: "2026-08-15T13:00:00.000Z",
    level: "error",
    event: "application_start_failed",
    error_name: "ConfigError",
    config_issues: [
      "ALLOWED_GUILD_IDS: 値が必要です",
      "SONIOX_VOICE_JA: 値が必要です",
    ],
  });
});

void test("通常の例外はmessageをログへ出さない", () => {
  const record = createFatalLogRecord(
    "application_start_failed",
    new Error("do-not-log-this-value"),
    new Date("2026-08-15T13:00:00Z"),
  );

  assert.equal(record.error_name, "Error");
  assert.equal("config_issues" in record, false);
  assert.doesNotMatch(JSON.stringify(record), /do-not-log-this-value/u);
});
