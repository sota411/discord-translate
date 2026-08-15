import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { ApplicationError } from "../domain/application-error.js";
import type { LanguagePair } from "../domain/language-pair.js";
import type { UsageGate } from "../session/session-manager.js";

export type Pricing = {
  sttMicrousdPerHour: number;
  ttsMicrousdPerHour: number;
  textMicrousdPerMillionCharactersUpperBound: number;
  safetyPercent: number;
};

export type UsageDelta = {
  sttStreamMs: number;
  ttsAudioMs: number;
  textCharacterCount: number;
};

export type UsageLimits = {
  userMonthlyCostMicrousd: number;
  guildMonthlyCostMicrousd: number;
  globalMonthlyCostMicrousd: number;
};

export type ScopeType = "user" | "guild" | "global";
export type ProviderKind = "stt" | "tts";
export type ProviderStatus = "open" | "completed" | "failed" | "reconciled";

type UsageLedgerOptions = {
  databasePath: string;
  pricing: Pricing;
  limits: UsageLimits;
  reconcileMaxStalenessSeconds: number;
};

type CreateSessionInput = {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  startedByUserId: string;
  pair: LanguagePair;
  startedAt: Date;
};

type OpenProviderRequestInput = {
  requestRef: string;
  sessionId: string;
  userId: string;
  kind: ProviderKind;
  startedAt: Date;
};

type ProviderUsageInput = {
  requestRef: string;
  audioMs: number;
  textCharacterCount: number;
  at: Date;
};

export type MonthlyUsage = UsageDelta & {
  estimatedCostMicrousd: number;
  reconciledCostMicrousd: number;
};

export type StoredSession = {
  sessionId: string;
  guildId: string;
  endedAt: string | null;
  endReason: string | null;
  estimatedCostMicrousd: number;
  reconciledCostMicrousd: number | null;
};

export type StoredProviderRequest = {
  requestRef: string;
  status: ProviderStatus;
  estimatedCostMicrousd: number;
  reconciledCostMicrousd: number | null;
};

type ProviderContextRow = {
  request_ref: string;
  session_id: string;
  user_id: string;
  kind: ProviderKind;
  status: ProviderStatus;
  guild_id: string;
  started_at: string;
  ended_at: string | null;
  reconciled_cost_microusd: number | null;
};

const schemaVersion = 1;
const millisecondsPerHour = 3_600_000n;
const charactersPerMillion = 1_000_000n;

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}は0以上の安全な整数で指定してください`);
  }
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("microUSDの計算結果がJavaScriptの安全な整数範囲を超えました");
  }
  return result;
}

export function estimateCostMicrousd(delta: UsageDelta, pricing: Pricing): number {
  assertNonNegativeSafeInteger("sttStreamMs", delta.sttStreamMs);
  assertNonNegativeSafeInteger("ttsAudioMs", delta.ttsAudioMs);
  assertNonNegativeSafeInteger("textCharacterCount", delta.textCharacterCount);
  assertNonNegativeSafeInteger("sttMicrousdPerHour", pricing.sttMicrousdPerHour);
  assertNonNegativeSafeInteger("ttsMicrousdPerHour", pricing.ttsMicrousdPerHour);
  assertNonNegativeSafeInteger(
    "textMicrousdPerMillionCharactersUpperBound",
    pricing.textMicrousdPerMillionCharactersUpperBound,
  );
  assertNonNegativeSafeInteger("safetyPercent", pricing.safetyPercent);

  const sttCost = ceilDivide(
    BigInt(delta.sttStreamMs) * BigInt(pricing.sttMicrousdPerHour),
    millisecondsPerHour,
  );
  const ttsCost = ceilDivide(
    BigInt(delta.ttsAudioMs) * BigInt(pricing.ttsMicrousdPerHour),
    millisecondsPerHour,
  );
  const textCost = ceilDivide(
    BigInt(delta.textCharacterCount) *
      BigInt(pricing.textMicrousdPerMillionCharactersUpperBound),
    charactersPerMillion,
  );
  return safeNumber(
    ceilDivide(
      (sttCost + ttsCost + textCost) * BigInt(pricing.safetyPercent),
      100n,
    ),
  );
}

export function usdDecimalToMicrousd(value: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match?.[1]) {
    throw new RangeError("USD費用は0以上の10進文字列で指定してください");
  }
  const fraction = match[2] ?? "";
  const micros = fraction.slice(0, 6).padEnd(6, "0");
  const mustRoundUp = /[1-9]/.test(fraction.slice(6));
  return safeNumber(
    BigInt(match[1]) * 1_000_000n + BigInt(micros) + (mustRoundUp ? 1n : 0n),
  );
}

function periodInTokyo(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new Error("Asia/Tokyoの利用月を計算できませんでした");
  }
  return `${year}-${month}`;
}

function subtractMonths(period: string, months: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match?.[1] || !match[2]) {
    throw new Error(`利用月の形式が不正です: ${period}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || !Number.isSafeInteger(months) || months < 0) {
    throw new Error(`利用月の計算条件が不正です: ${period}`);
  }
  const shifted = year * 12 + month - 1 - months;
  const shiftedYear = Math.floor(shifted / 12);
  const shiftedMonth = shifted % 12 + 1;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
}

function periodStartUtc(period: string): string {
  const start = new Date(`${period}-01T00:00:00+09:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`利用月の開始日時を計算できません: ${period}`);
  }
  return start.toISOString();
}

function migrate(database: Database.Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  if (currentVersion > schemaVersion) {
    throw new Error(`SQLite schema version ${String(currentVersion)}は未対応です`);
  }
  if (currentVersion === schemaVersion) return;

  database.transaction(() => {
    database.exec(`
      CREATE TABLE session_usage (
        session_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        voice_channel_id TEXT NOT NULL,
        text_channel_id TEXT NOT NULL,
        started_by_user_id TEXT NOT NULL,
        pair TEXT NOT NULL CHECK (pair IN ('ja-ko', 'ja-en', 'ko-en')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        stt_stream_ms INTEGER NOT NULL DEFAULT 0 CHECK (stt_stream_ms >= 0),
        tts_audio_ms INTEGER NOT NULL DEFAULT 0 CHECK (tts_audio_ms >= 0),
        text_character_count INTEGER NOT NULL DEFAULT 0 CHECK (text_character_count >= 0),
        estimated_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_microusd >= 0),
        reconciled_cost_microusd INTEGER CHECK (reconciled_cost_microusd >= 0)
      );

      CREATE TABLE provider_request (
        request_ref TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_usage(session_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('stt', 'tts')),
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed', 'reconciled')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        audio_ms INTEGER NOT NULL DEFAULT 0 CHECK (audio_ms >= 0),
        text_character_count INTEGER NOT NULL DEFAULT 0 CHECK (text_character_count >= 0),
        estimated_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_microusd >= 0),
        reconciled_cost_microusd INTEGER CHECK (reconciled_cost_microusd >= 0)
      );

      CREATE INDEX provider_request_session_idx ON provider_request(session_id);
      CREATE INDEX provider_request_status_idx ON provider_request(status);

      CREATE TABLE monthly_usage (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'guild', 'global')),
        scope_id TEXT NOT NULL,
        period TEXT NOT NULL,
        stt_stream_ms INTEGER NOT NULL DEFAULT 0 CHECK (stt_stream_ms >= 0),
        tts_audio_ms INTEGER NOT NULL DEFAULT 0 CHECK (tts_audio_ms >= 0),
        text_character_count INTEGER NOT NULL DEFAULT 0 CHECK (text_character_count >= 0),
        estimated_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_microusd >= 0),
        reconciled_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reconciled_cost_microusd >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_type, scope_id, period)
      );

      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database.pragma(`user_version = ${String(schemaVersion)}`);
  })();
}

export class UsageLedger implements UsageGate {
  readonly #database: Database.Database;
  readonly #pricing: Pricing;
  readonly #limits: UsageLimits;
  readonly #reconcileMaxStalenessSeconds: number;
  #closed = false;

  private constructor(options: UsageLedgerOptions) {
    mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Database(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.#pricing = options.pricing;
    this.#limits = options.limits;
    this.#reconcileMaxStalenessSeconds = options.reconcileMaxStalenessSeconds;
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("busy_timeout = 5000");
    migrate(this.#database);
  }

  public static open(options: UsageLedgerOptions): UsageLedger {
    return new UsageLedger(options);
  }

  public close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  public createSession(input: CreateSessionInput): void {
    this.#database.prepare(`
      INSERT INTO session_usage (
        session_id, guild_id, voice_channel_id, text_channel_id,
        started_by_user_id, pair, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.guildId,
      input.voiceChannelId,
      input.textChannelId,
      input.startedByUserId,
      input.pair,
      input.startedAt.toISOString(),
    );
  }

  public finishSession(sessionId: string, reason: string, endedAt: Date): void {
    this.#database.prepare(`
      UPDATE session_usage
      SET ended_at = ?, end_reason = ?
      WHERE session_id = ? AND ended_at IS NULL
    `).run(endedAt.toISOString(), reason, sessionId);
  }

  public openProviderRequest(input: OpenProviderRequestInput): void {
    this.#database.prepare(`
      INSERT INTO provider_request (
        request_ref, session_id, user_id, kind, status, started_at
      ) VALUES (?, ?, ?, ?, 'open', ?)
    `).run(
      input.requestRef,
      input.sessionId,
      input.userId,
      input.kind,
      input.startedAt.toISOString(),
    );
  }

  public recordProviderUsage(input: ProviderUsageInput): void {
    assertNonNegativeSafeInteger("audioMs", input.audioMs);
    assertNonNegativeSafeInteger("textCharacterCount", input.textCharacterCount);

    const scopes = this.#database.transaction(() => {
      const context = this.#providerContext(input.requestRef);
      if (context.status !== "open") {
        throw new Error(`provider request ${input.requestRef}はopenではありません`);
      }
      const delta: UsageDelta = {
        sttStreamMs: context.kind === "stt" ? input.audioMs : 0,
        ttsAudioMs: context.kind === "tts" ? input.audioMs : 0,
        textCharacterCount: input.textCharacterCount,
      };
      const estimatedCostMicrousd = estimateCostMicrousd(delta, this.#pricing);

      this.#database.prepare(`
        UPDATE provider_request
        SET audio_ms = audio_ms + ?,
            text_character_count = text_character_count + ?,
            estimated_cost_microusd = estimated_cost_microusd + ?
        WHERE request_ref = ?
      `).run(
        input.audioMs,
        input.textCharacterCount,
        estimatedCostMicrousd,
        input.requestRef,
      );
      this.#database.prepare(`
        UPDATE session_usage
        SET stt_stream_ms = stt_stream_ms + ?,
            tts_audio_ms = tts_audio_ms + ?,
            text_character_count = text_character_count + ?,
            estimated_cost_microusd = estimated_cost_microusd + ?
        WHERE session_id = ?
      `).run(
        delta.sttStreamMs,
        delta.ttsAudioMs,
        delta.textCharacterCount,
        estimatedCostMicrousd,
        context.session_id,
      );

      const period = periodInTokyo(input.at);
      this.#addMonthlyUsage("user", context.user_id, period, delta, estimatedCostMicrousd, 0, input.at);
      this.#addMonthlyUsage("guild", context.guild_id, period, delta, estimatedCostMicrousd, 0, input.at);
      this.#addMonthlyUsage("global", "global", period, delta, estimatedCostMicrousd, 0, input.at);
      return { userId: context.user_id, guildId: context.guild_id, period };
    })();
    this.#assertBelowLimit(
      "user",
      scopes.userId,
      scopes.period,
      this.#limits.userMonthlyCostMicrousd,
    );
    this.#assertBelowLimit(
      "guild",
      scopes.guildId,
      scopes.period,
      this.#limits.guildMonthlyCostMicrousd,
    );
    this.#assertBelowLimit(
      "global",
      "global",
      scopes.period,
      this.#limits.globalMonthlyCostMicrousd,
    );
  }

  public finishProviderRequest(
    requestRef: string,
    status: "completed" | "failed",
    endedAt: Date,
  ): void {
    this.#database.prepare(`
      UPDATE provider_request
      SET status = ?, ended_at = ?
      WHERE request_ref = ? AND status = 'open'
    `).run(status, endedAt.toISOString(), requestRef);
  }

  public reconcileProviderRequest(
    requestRef: string,
    reconciledCostMicrousd: number,
    at: Date,
  ): void {
    assertNonNegativeSafeInteger("reconciledCostMicrousd", reconciledCostMicrousd);
    this.#database.transaction(() => {
      const context = this.#providerContext(requestRef);
      const previous = context.reconciled_cost_microusd ?? 0;
      const delta = reconciledCostMicrousd - previous;
      this.#database.prepare(`
        UPDATE provider_request
        SET reconciled_cost_microusd = ?, status = 'reconciled'
        WHERE request_ref = ?
      `).run(reconciledCostMicrousd, requestRef);
      this.#database.prepare(`
        UPDATE session_usage
        SET reconciled_cost_microusd = COALESCE(reconciled_cost_microusd, 0) + ?
        WHERE session_id = ?
      `).run(delta, context.session_id);

      const emptyDelta: UsageDelta = {
        sttStreamMs: 0,
        ttsAudioMs: 0,
        textCharacterCount: 0,
      };
      const usageEndedAt = new Date(context.ended_at ?? context.started_at);
      if (Number.isNaN(usageEndedAt.getTime())) {
        throw new Error(`provider request ${requestRef}の利用日時が不正です`);
      }
      const period = periodInTokyo(usageEndedAt);
      this.#addMonthlyUsage("user", context.user_id, period, emptyDelta, 0, delta, at);
      this.#addMonthlyUsage("guild", context.guild_id, period, emptyDelta, 0, delta, at);
      this.#addMonthlyUsage("global", "global", period, emptyDelta, 0, delta, at);
    })();
  }

  public markReconciled(at: Date): void {
    this.#database.prepare(`
      INSERT INTO app_meta (key, value) VALUES ('last_reconciled_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(at.toISOString());
  }

  public getLastReconciledAt(): Date | undefined {
    const row = this.#database.prepare(
      "SELECT value FROM app_meta WHERE key = 'last_reconciled_at'",
    ).get() as { value: string } | undefined;
    if (!row) return undefined;
    const at = new Date(row.value);
    if (Number.isNaN(at.getTime())) {
      throw new Error("last_reconciled_atが不正です");
    }
    return at;
  }

  public hasProviderRequest(requestRef: string): boolean {
    return this.#database.prepare(
      "SELECT 1 FROM provider_request WHERE request_ref = ?",
    ).get(requestRef) !== undefined;
  }

  public assertCanStart(input: {
    guildId: string;
    userIds: readonly string[];
    at: Date;
  }): Promise<void> {
    return Promise.resolve().then(() => {
      try {
        this.#database.transaction(() => {
          this.#database.prepare(`
            INSERT INTO app_meta (key, value) VALUES ('writable_check', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(input.at.toISOString());
        })();
      } catch (error) {
        throw new ApplicationError(
          "USAGE_LEDGER_UNAVAILABLE",
          "利用量台帳へ書き込めないため、翻訳を開始できません。",
          { cause: error },
        );
      }

      const row = this.#database.prepare(
        "SELECT value FROM app_meta WHERE key = 'last_reconciled_at'",
      ).get() as { value: string } | undefined;
      const reconciledAt = row ? new Date(row.value) : undefined;
      const ageSeconds = reconciledAt
        ? (input.at.getTime() - reconciledAt.getTime()) / 1000
        : Number.POSITIVE_INFINITY;
      if (
        !reconciledAt ||
        !Number.isFinite(reconciledAt.getTime()) ||
        ageSeconds < 0 ||
        ageSeconds > this.#reconcileMaxStalenessSeconds
      ) {
        throw new ApplicationError(
          "USAGE_RECONCILIATION_STALE",
          "Sonioxの利用量照合が古いため、翻訳を開始できません。",
        );
      }

      const period = periodInTokyo(input.at);
      for (const userId of new Set(input.userIds)) {
        this.#assertBelowLimit(
          "user",
          userId,
          period,
          this.#limits.userMonthlyCostMicrousd,
        );
      }
      this.#assertBelowLimit(
        "guild",
        input.guildId,
        period,
        this.#limits.guildMonthlyCostMicrousd,
      );
      this.#assertBelowLimit(
        "global",
        "global",
        period,
        this.#limits.globalMonthlyCostMicrousd,
      );
    });
  }

  public getMonthlyUsage(scopeType: ScopeType, scopeId: string, at: Date): MonthlyUsage {
    const row = this.#database.prepare(`
      SELECT stt_stream_ms, tts_audio_ms, text_character_count,
             estimated_cost_microusd, reconciled_cost_microusd
      FROM monthly_usage
      WHERE scope_type = ? AND scope_id = ? AND period = ?
    `).get(scopeType, scopeId, periodInTokyo(at)) as {
      stt_stream_ms: number;
      tts_audio_ms: number;
      text_character_count: number;
      estimated_cost_microusd: number;
      reconciled_cost_microusd: number;
    } | undefined;
    return {
      sttStreamMs: row?.stt_stream_ms ?? 0,
      ttsAudioMs: row?.tts_audio_ms ?? 0,
      textCharacterCount: row?.text_character_count ?? 0,
      estimatedCostMicrousd: row?.estimated_cost_microusd ?? 0,
      reconciledCostMicrousd: row?.reconciled_cost_microusd ?? 0,
    };
  }

  public getSession(sessionId: string): StoredSession | undefined {
    const row = this.#database.prepare(`
      SELECT session_id, guild_id, ended_at, end_reason,
             estimated_cost_microusd, reconciled_cost_microusd
      FROM session_usage WHERE session_id = ?
    `).get(sessionId) as {
      session_id: string;
      guild_id: string;
      ended_at: string | null;
      end_reason: string | null;
      estimated_cost_microusd: number;
      reconciled_cost_microusd: number | null;
    } | undefined;
    return row
      ? {
          sessionId: row.session_id,
          guildId: row.guild_id,
          endedAt: row.ended_at,
          endReason: row.end_reason,
          estimatedCostMicrousd: row.estimated_cost_microusd,
          reconciledCostMicrousd: row.reconciled_cost_microusd,
        }
      : undefined;
  }

  public getProviderRequest(requestRef: string): StoredProviderRequest | undefined {
    const row = this.#database.prepare(`
      SELECT request_ref, status, estimated_cost_microusd, reconciled_cost_microusd
      FROM provider_request WHERE request_ref = ?
    `).get(requestRef) as {
      request_ref: string;
      status: ProviderStatus;
      estimated_cost_microusd: number;
      reconciled_cost_microusd: number | null;
    } | undefined;
    return row
      ? {
          requestRef: row.request_ref,
          status: row.status,
          estimatedCostMicrousd: row.estimated_cost_microusd,
          reconciledCostMicrousd: row.reconciled_cost_microusd,
        }
      : undefined;
  }

  public listTableColumns(
    table: "session_usage" | "provider_request" | "monthly_usage",
  ): string[] {
    const rows = this.#database.pragma(`table_info(${table})`) as { name: string }[];
    return rows.map((row) => row.name);
  }

  public recoverInterruptedWork(at: Date): {
    sessions: number;
    providerRequests: number;
  } {
    return this.#database.transaction(() => {
      const providerRequests = this.#database.prepare(`
        UPDATE provider_request
        SET status = 'failed', ended_at = ?
        WHERE status = 'open'
      `).run(at.toISOString()).changes;
      const sessions = this.#database.prepare(`
        UPDATE session_usage
        SET ended_at = ?, end_reason = 'PROCESS_RESTART'
        WHERE ended_at IS NULL
      `).run(at.toISOString()).changes;
      return { sessions, providerRequests };
    })();
  }

  public pruneExpiredUsage(at: Date): {
    sessions: number;
    monthlyUsageRows: number;
  } {
    const currentPeriod = periodInTokyo(at);
    const oldestIndividualPeriod = subtractMonths(currentPeriod, 1);
    const oldestGlobalPeriod = subtractMonths(currentPeriod, 11);
    const oldestRetainedAt = periodStartUtc(oldestIndividualPeriod);
    return this.#database.transaction(() => {
      const sessions = this.#database.prepare(`
        DELETE FROM session_usage
        WHERE ended_at IS NOT NULL AND started_at < ?
      `).run(oldestRetainedAt).changes;
      const monthlyUsageRows = this.#database.prepare(`
        DELETE FROM monthly_usage
        WHERE (scope_type IN ('user', 'guild') AND period < ?)
           OR (scope_type = 'global' AND period < ?)
      `).run(oldestIndividualPeriod, oldestGlobalPeriod).changes;
      return { sessions, monthlyUsageRows };
    })();
  }

  #providerContext(requestRef: string): ProviderContextRow {
    const row = this.#database.prepare(`
      SELECT provider_request.request_ref, provider_request.session_id,
             provider_request.user_id, provider_request.kind,
             provider_request.status, provider_request.started_at,
             provider_request.ended_at, provider_request.reconciled_cost_microusd,
             session_usage.guild_id
      FROM provider_request
      JOIN session_usage USING (session_id)
      WHERE provider_request.request_ref = ?
    `).get(requestRef) as ProviderContextRow | undefined;
    if (!row) throw new Error(`provider request ${requestRef}が見つかりません`);
    return row;
  }

  #addMonthlyUsage(
    scopeType: ScopeType,
    scopeId: string,
    period: string,
    delta: UsageDelta,
    estimatedCostMicrousd: number,
    reconciledCostMicrousd: number,
    at: Date,
  ): void {
    this.#database.prepare(`
      INSERT INTO monthly_usage (
        scope_type, scope_id, period, stt_stream_ms, tts_audio_ms,
        text_character_count, estimated_cost_microusd,
        reconciled_cost_microusd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id, period) DO UPDATE SET
        stt_stream_ms = stt_stream_ms + excluded.stt_stream_ms,
        tts_audio_ms = tts_audio_ms + excluded.tts_audio_ms,
        text_character_count = text_character_count + excluded.text_character_count,
        estimated_cost_microusd = estimated_cost_microusd + excluded.estimated_cost_microusd,
        reconciled_cost_microusd = reconciled_cost_microusd + excluded.reconciled_cost_microusd,
        updated_at = excluded.updated_at
    `).run(
      scopeType,
      scopeId,
      period,
      delta.sttStreamMs,
      delta.ttsAudioMs,
      delta.textCharacterCount,
      estimatedCostMicrousd,
      reconciledCostMicrousd,
      at.toISOString(),
    );
  }

  #assertBelowLimit(
    scopeType: ScopeType,
    scopeId: string,
    period: string,
    limit: number,
  ): void {
    const row = this.#database.prepare(`
      SELECT estimated_cost_microusd, reconciled_cost_microusd
      FROM monthly_usage
      WHERE scope_type = ? AND scope_id = ? AND period = ?
    `).get(scopeType, scopeId, period) as {
      estimated_cost_microusd: number;
      reconciled_cost_microusd: number;
    } | undefined;
    const current = Math.max(
      row?.estimated_cost_microusd ?? 0,
      row?.reconciled_cost_microusd ?? 0,
    );
    if (current >= limit) {
      throw new ApplicationError(
        "USAGE_LIMIT_REACHED",
        `${scopeType}の月間利用上限へ達しています。翌月または上限変更後に再実行してください。`,
      );
    }
  }
}
