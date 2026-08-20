import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ApplicationError } from "../src/domain/application-error.js";
import {
  UsageLedger,
  estimateCostMicrousd,
  usdDecimalToMicrousd,
} from "../src/usage/usage-ledger.js";

const pricing = {
  sttMicrousdPerHour: 120_000,
  ttsMicrousdPerHour: 700_000,
  textMicrousdPerMillionCharactersUpperBound: 100_000,
  safetyPercent: 125,
};

const limits = {
  userMonthlyCostMicrousd: 1_000_000,
  guildMonthlyCostMicrousd: 3_000_000,
  globalMonthlyCostMicrousd: 4_000_000,
};

async function withLedger(
  run: (ledger: UsageLedger, databasePath: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "discord-translate-ledger-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const ledger = UsageLedger.open({
    databasePath,
    pricing,
    limits,
    reconcileMaxStalenessSeconds: 180,
  });
  try {
    await run(ledger, databasePath);
  } finally {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void test("音声時間と文字数を整数microUSDへ安全側に見積もる", () => {
  assert.equal(
    estimateCostMicrousd(
      { sttStreamMs: 3_600_000, ttsAudioMs: 0, textCharacterCount: 100 },
      pricing,
    ),
    150_013,
  );
  assert.equal(usdDecimalToMicrousd("0.123456"), 123_456);
  assert.equal(usdDecimalToMicrousd("0.0000001"), 1);
});

void test("利用量は本文なしでUser・Guild・globalへ永続化される", async () => {
  await withLedger((ledger, databasePath) => {
    const startedAt = new Date("2026-08-15T03:00:00Z");
    ledger.createSession({
      sessionId: "00000000-0000-4000-8000-000000000001",
      guildId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      textChannelId: "623456789012345678",
      startedByUserId: "323456789012345678",
      pair: "ja-ko",
      startedAt,
    });
    ledger.openProviderRequest({
      requestRef: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      userId: "323456789012345678",
      kind: "stt",
      startedAt,
    });
    ledger.recordProviderUsage({
      requestRef: "00000000-0000-4000-8000-000000000002",
      audioMs: 3_600_000,
      textCharacterCount: 100,
      at: new Date("2026-08-15T04:00:00Z"),
    });
    ledger.finishProviderRequest(
      "00000000-0000-4000-8000-000000000002",
      "completed",
      new Date("2026-08-15T04:00:00Z"),
    );
    ledger.finishSession(
      "00000000-0000-4000-8000-000000000001",
      "USER_REQUEST",
      new Date("2026-08-15T04:00:00Z"),
    );
    ledger.close();

    const reopened = UsageLedger.open({
      databasePath,
      pricing,
      limits,
      reconcileMaxStalenessSeconds: 180,
    });
    try {
      const user = reopened.getMonthlyUsage(
        "user",
        "323456789012345678",
        startedAt,
      );
      const guild = reopened.getMonthlyUsage(
        "guild",
        "223456789012345678",
        startedAt,
      );
      const global = reopened.getMonthlyUsage("global", "global", startedAt);
      assert.equal(user.estimatedCostMicrousd, 150_013);
      assert.equal(guild.estimatedCostMicrousd, 150_013);
      assert.equal(global.estimatedCostMicrousd, 150_013);
      assert.equal(user.sttStreamMs, 3_600_000);
      assert.equal(reopened.getSession("00000000-0000-4000-8000-000000000001")?.endReason, "USER_REQUEST");
      assert.deepEqual(reopened.listTableColumns("session_usage").includes("transcript"), false);
      assert.deepEqual(reopened.listTableColumns("provider_request").includes("text"), false);
    } finally {
      reopened.close();
    }
  });
});

void test("SQLite利用量台帳は所有者だけが読み書きできる", async () => {
  await withLedger(async (_ledger, databasePath) => {
    const mode = (await stat(databasePath)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

void test("Guild別翻訳用語をSQLiteへ保存し、再起動後もsource順で読み出す", async () => {
  await withLedger((ledger, databasePath) => {
    ledger.upsertRegisteredTranslationTerm({
      guildId: "223456789012345678",
      pair: "ja-ko",
      source: "ult",
      target: "궁극기",
      updatedAt: new Date("2026-08-21T03:00:00Z"),
    });
    ledger.upsertRegisteredTranslationTerm({
      guildId: "223456789012345678",
      pair: "ja-ko",
      source: "ace",
      target: "에이스",
      updatedAt: new Date("2026-08-21T03:01:00Z"),
    });
    ledger.upsertRegisteredTranslationTerm({
      guildId: "999999999999999999",
      pair: "ja-ko",
      source: "ult",
      target: "필살기",
      updatedAt: new Date("2026-08-21T03:02:00Z"),
    });
    ledger.close();

    const reopened = UsageLedger.open({
      databasePath,
      pricing,
      limits,
      reconcileMaxStalenessSeconds: 180,
    });
    try {
      assert.deepEqual(
        reopened.listRegisteredTranslationTerms("223456789012345678", "ja-ko"),
        [
          { source: "ace", target: "에이스" },
          { source: "ult", target: "궁극기" },
        ],
      );
      assert.deepEqual(
        reopened.listRegisteredTranslationTerms("999999999999999999", "ja-ko"),
        [{ source: "ult", target: "필살기" }],
      );
    } finally {
      reopened.close();
    }
  });
});

void test("SQLite version 1から用語テーブルだけを追加し、既存利用量を保持する", async () => {
  await withLedger((ledger, databasePath) => {
    ledger.createSession({
      sessionId: "00000000-0000-4000-8000-000000000050",
      guildId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      textChannelId: "623456789012345678",
      startedByUserId: "323456789012345678",
      pair: "ja-en",
      startedAt: new Date("2026-08-21T03:00:00Z"),
    });
    ledger.close();

    const versionOne = new Database(databasePath);
    versionOne.exec("DROP TABLE registered_translation_term");
    versionOne.pragma("user_version = 1");
    versionOne.close();

    const migrated = UsageLedger.open({
      databasePath,
      pricing,
      limits,
      reconcileMaxStalenessSeconds: 180,
    });
    try {
      assert.ok(migrated.getSession("00000000-0000-4000-8000-000000000050"));
      assert.deepEqual(
        migrated.listRegisteredTranslationTerms("223456789012345678", "ja-en"),
        [],
      );
      migrated.upsertRegisteredTranslationTerm({
        guildId: "223456789012345678",
        pair: "ja-en",
        source: "固有名詞",
        target: "proper noun",
        updatedAt: new Date("2026-08-21T04:00:00Z"),
      });
    } finally {
      migrated.close();
    }
  });
});

void test("照合が古い場合と月額上限到達時は新規開始をFail Closedで拒否する", async () => {
  await withLedger(async (ledger) => {
    const at = new Date("2026-08-15T03:00:00Z");
    ledger.markReconciled(at);
    await ledger.assertCanStart({
      guildId: "223456789012345678",
      userIds: ["323456789012345678"],
      at: new Date("2026-08-15T03:02:00Z"),
    });

    await assert.rejects(
      ledger.assertCanStart({
        guildId: "223456789012345678",
        userIds: ["323456789012345678"],
        at: new Date("2026-08-15T03:04:00Z"),
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "USAGE_RECONCILIATION_STALE",
    );

    ledger.createSession({
      sessionId: "00000000-0000-4000-8000-000000000010",
      guildId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      textChannelId: "623456789012345678",
      startedByUserId: "323456789012345678",
      pair: "ja-ko",
      startedAt: at,
    });
    ledger.openProviderRequest({
      requestRef: "00000000-0000-4000-8000-000000000011",
      sessionId: "00000000-0000-4000-8000-000000000010",
      userId: "323456789012345678",
      kind: "stt",
      startedAt: at,
    });
    assert.throws(
      () => ledger.recordProviderUsage({
        requestRef: "00000000-0000-4000-8000-000000000011",
        audioMs: 24_000_000,
        textCharacterCount: 0,
        at,
      }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "USAGE_LIMIT_REACHED",
    );
    ledger.markReconciled(at);

    await assert.rejects(
      ledger.assertCanStart({
        guildId: "223456789012345678",
        userIds: ["323456789012345678"],
        at,
      }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "USAGE_LIMIT_REACHED",
    );
  });
});

void test("再起動時に未終了セッションとprovider requestを失敗終了へ回収する", async () => {
  await withLedger((ledger) => {
    const at = new Date("2026-08-15T03:00:00Z");
    ledger.createSession({
      sessionId: "00000000-0000-4000-8000-000000000020",
      guildId: "223456789012345678",
      voiceChannelId: "523456789012345678",
      textChannelId: "623456789012345678",
      startedByUserId: "323456789012345678",
      pair: "ja-en",
      startedAt: at,
    });
    ledger.openProviderRequest({
      requestRef: "00000000-0000-4000-8000-000000000021",
      sessionId: "00000000-0000-4000-8000-000000000020",
      userId: "323456789012345678",
      kind: "tts",
      startedAt: at,
    });

    const recovered = ledger.recoverInterruptedWork(
      new Date("2026-08-15T03:05:00Z"),
    );

    assert.deepEqual(recovered, { sessions: 1, providerRequests: 1 });
    assert.equal(
      ledger.getSession("00000000-0000-4000-8000-000000000020")?.endReason,
      "PROCESS_RESTART",
    );
    assert.equal(
      ledger.getProviderRequest("00000000-0000-4000-8000-000000000021")?.status,
      "failed",
    );
  });
});

void test("User・Guildは2か月、globalは12か月を残し、古いセッションを関連要求ごと削除する", async () => {
  await withLedger((ledger) => {
    const createCompletedUsage = (
      suffix: string,
      startedAt: Date,
    ): { sessionId: string; requestRef: string } => {
      const sessionId = `00000000-0000-4000-8000-0000000000${suffix}`;
      const requestRef = `10000000-0000-4000-8000-0000000000${suffix}`;
      ledger.createSession({
        sessionId,
        guildId: "223456789012345678",
        voiceChannelId: "523456789012345678",
        textChannelId: "623456789012345678",
        startedByUserId: "323456789012345678",
        pair: "ja-ko",
        startedAt,
      });
      ledger.openProviderRequest({
        requestRef,
        sessionId,
        userId: "323456789012345678",
        kind: "stt",
        startedAt,
      });
      ledger.recordProviderUsage({
        requestRef,
        audioMs: 1_000,
        textCharacterCount: 0,
        at: startedAt,
      });
      ledger.finishProviderRequest(requestRef, "completed", startedAt);
      ledger.finishSession(sessionId, "USER_REQUEST", startedAt);
      return { sessionId, requestRef };
    };

    const augustLastYear = createCompletedUsage("29", new Date("2025-08-15T03:00:00Z"));
    const june = createCompletedUsage("30", new Date("2026-06-15T03:00:00Z"));
    const july = createCompletedUsage("31", new Date("2026-07-15T03:00:00Z"));
    const removed = ledger.pruneExpiredUsage(new Date("2026-08-15T03:00:00Z"));

    assert.deepEqual(removed, { sessions: 2, monthlyUsageRows: 5 });
    assert.equal(ledger.getSession(augustLastYear.sessionId), undefined);
    assert.equal(ledger.getProviderRequest(augustLastYear.requestRef), undefined);
    assert.equal(ledger.getSession(june.sessionId), undefined);
    assert.equal(ledger.getProviderRequest(june.requestRef), undefined);
    assert.ok(ledger.getSession(july.sessionId));
    assert.ok(ledger.getProviderRequest(july.requestRef));
    assert.ok(
      ledger.getMonthlyUsage("global", "global", new Date("2026-06-15T03:00:00Z"))
        .estimatedCostMicrousd > 0,
    );
    assert.equal(
      ledger.getMonthlyUsage("global", "global", new Date("2025-08-15T03:00:00Z"))
        .estimatedCostMicrousd,
      0,
    );
    assert.ok(
      ledger.getMonthlyUsage("global", "global", new Date("2026-07-15T03:00:00Z"))
        .estimatedCostMicrousd > 0,
    );
  });
});
