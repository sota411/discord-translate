import path from "node:path";

import { z } from "zod";

const snowflakePattern = /^\d{17,20}$/;

const positiveInteger = z.coerce.number()
  .int("整数を指定してください")
  .positive("1以上の整数を指定してください");
const requiredString = z.string().min(1, "値が必要です");

const rawConfigSchema = z.object({
  DISCORD_TOKEN: requiredString,
  DISCORD_APPLICATION_ID: z.string().regex(snowflakePattern),
  ALLOWED_GUILD_IDS: requiredString,
  ALLOWED_USER_IDS: requiredString,
  SONIOX_API_KEY: requiredString,
  SONIOX_REGION: requiredString,
  SESSION_MAX_MINUTES: positiveInteger,
  MAX_SPEAKERS_PER_SESSION: positiveInteger,
  SESSION_IDLE_TIMEOUT_SECONDS: positiveInteger,
  PLAYBACK_QUEUE_MAX_MS: positiveInteger,
  UTTERANCE_MAX_SOURCE_SECONDS: positiveInteger,
  TTS_MAX_INPUT_CHARACTERS: positiveInteger,
  VOICE_RECONNECT_TIMEOUT_MS: positiveInteger,
  SONIOX_TERMINATION_TIMEOUT_MS: positiveInteger,
  USER_MONTHLY_COST_LIMIT_MICROUSD: positiveInteger,
  GUILD_MONTHLY_COST_LIMIT_MICROUSD: positiveInteger,
  GLOBAL_MONTHLY_COST_LIMIT_MICROUSD: positiveInteger,
  SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD: positiveInteger,
  STT_COST_MICROUSD_PER_HOUR: positiveInteger,
  TTS_COST_MICROUSD_PER_HOUR: positiveInteger,
  TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND: positiveInteger,
  COST_ESTIMATE_SAFETY_PERCENT: z.coerce.number()
    .int("整数を指定してください")
    .min(100, "100以上の整数を指定してください"),
  PRICING_CONFIRMED_AT: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  PRICING_MAX_AGE_DAYS: positiveInteger,
  USAGE_RECONCILE_INTERVAL_SECONDS: positiveInteger,
  USAGE_RECONCILE_MAX_STALENESS_SECONDS: positiveInteger,
  SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS: positiveInteger,
  SONIOX_STT_MODEL: requiredString,
  SONIOX_TTS_MODEL: requiredString,
  SONIOX_VOICE_JA: requiredString,
  SONIOX_VOICE_KO: requiredString,
  SONIOX_VOICE_EN: requiredString,
  TRANSLATION_TERMS_PATH: z.string().optional(),
  SQLITE_PATH: requiredString,
  LOG_ID_HMAC_KEY: z.string().min(32, "32文字以上で指定してください"),
});

export type SonioxRegion = "us" | "eu" | "jp";

export type AppConfig = {
  discord: {
    token: string;
    applicationId: string;
    allowedGuildIds: ReadonlySet<string>;
    allowedUserIds: ReadonlySet<string>;
  };
  soniox: {
    apiKey: string;
    region: SonioxRegion;
    restBaseUrl: string;
    ttsRestBaseUrl: string;
    sttWebSocketUrl: string;
    ttsWebSocketUrl: string;
    sttModel: string;
    ttsModel: string;
    voices: Readonly<Record<"ja" | "ko" | "en", string>>;
    terminationTimeoutMs: number;
    projectMonthlyBudgetMicrousd: number;
    limitCheckMaxStalenessSeconds: number;
  };
  limits: {
    sessionMaxMinutes: number;
    maxSpeakersPerSession: 2;
    sessionIdleTimeoutSeconds: number;
    playbackQueueMaxMs: number;
    utteranceMaxSourceSeconds: number;
    ttsMaxInputCharacters: number;
    voiceReconnectTimeoutMs: number;
    userMonthlyCostMicrousd: number;
    guildMonthlyCostMicrousd: number;
    globalMonthlyCostMicrousd: number;
  };
  pricing: {
    sttMicrousdPerHour: number;
    ttsMicrousdPerHour: number;
    textMicrousdPerMillionCharactersUpperBound: number;
    safetyPercent: number;
    confirmedAt: string;
    maxAgeDays: number;
  };
  usage: {
    reconcileIntervalSeconds: number;
    reconcileMaxStalenessSeconds: number;
  };
  storage: {
    sqlitePath: string;
    translationTermsPath?: string;
  };
  logIdHmacKey: string;
};

export class ConfigError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`設定が不正です:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type RegionEndpoints = Pick<
  AppConfig["soniox"],
  "restBaseUrl" | "ttsRestBaseUrl" | "sttWebSocketUrl" | "ttsWebSocketUrl"
>;

const regionEndpoints: Readonly<Record<SonioxRegion, RegionEndpoints>> = {
  us: {
    restBaseUrl: "https://api.soniox.com",
    ttsRestBaseUrl: "https://tts-rt.soniox.com",
    sttWebSocketUrl: "wss://stt-rt.soniox.com/transcribe-websocket",
    ttsWebSocketUrl: "wss://tts-rt.soniox.com/tts-websocket",
  },
  eu: {
    restBaseUrl: "https://api.eu.soniox.com",
    ttsRestBaseUrl: "https://tts-rt.eu.soniox.com",
    sttWebSocketUrl: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
    ttsWebSocketUrl: "wss://tts-rt.eu.soniox.com/tts-websocket",
  },
  jp: {
    restBaseUrl: "https://api.jp.soniox.com",
    ttsRestBaseUrl: "https://tts-rt.jp.soniox.com",
    sttWebSocketUrl: "wss://stt-rt.jp.soniox.com/transcribe-websocket",
    ttsWebSocketUrl: "wss://tts-rt.jp.soniox.com/tts-websocket",
  },
};

export function getSonioxRegionEndpoints(region: SonioxRegion): RegionEndpoints {
  return regionEndpoints[region];
}

function parseSnowflakeList(name: string, value: string, issues: string[]): Set<string> {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !snowflakePattern.test(entry))) {
    issues.push(`${name}: 17〜20桁のDiscord IDをカンマ区切りで1件以上指定してください`);
  }
  return new Set(entries);
}

function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AppConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const name = issue.path[0]?.toString() ?? "環境変数";
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const raw = parsed.data;
  const issues: string[] = [];
  const allowedGuildIds = parseSnowflakeList(
    "ALLOWED_GUILD_IDS",
    raw.ALLOWED_GUILD_IDS,
    issues,
  );
  const allowedUserIds = parseSnowflakeList(
    "ALLOWED_USER_IDS",
    raw.ALLOWED_USER_IDS,
    issues,
  );

  if (!(["us", "eu", "jp"] as const).includes(raw.SONIOX_REGION as SonioxRegion)) {
    issues.push("SONIOX_REGION: us、eu、jpのいずれかを指定してください");
  }

  if (raw.MAX_SPEAKERS_PER_SESSION !== 2) {
    issues.push("MAX_SPEAKERS_PER_SESSION: MVPでは2に固定してください");
  }
  if (raw.USER_MONTHLY_COST_LIMIT_MICROUSD > raw.GUILD_MONTHLY_COST_LIMIT_MICROUSD) {
    issues.push("GUILD_MONTHLY_COST_LIMIT_MICROUSD: User上限以上にしてください");
  }
  if (raw.GUILD_MONTHLY_COST_LIMIT_MICROUSD > raw.GLOBAL_MONTHLY_COST_LIMIT_MICROUSD) {
    issues.push("GLOBAL_MONTHLY_COST_LIMIT_MICROUSD: Guild上限以上にしてください");
  }
  if (raw.GLOBAL_MONTHLY_COST_LIMIT_MICROUSD >= raw.SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD) {
    issues.push(
      "GLOBAL_MONTHLY_COST_LIMIT_MICROUSD: Soniox Project月額上限より小さくしてください",
    );
  }
  if (raw.USAGE_RECONCILE_MAX_STALENESS_SECONDS <= raw.USAGE_RECONCILE_INTERVAL_SECONDS) {
    issues.push(
      "USAGE_RECONCILE_MAX_STALENESS_SECONDS: 照合間隔より大きくしてください",
    );
  }
  if (!path.isAbsolute(raw.SQLITE_PATH)) {
    issues.push("SQLITE_PATH: 絶対パスを指定してください");
  }
  if (raw.TRANSLATION_TERMS_PATH && !path.isAbsolute(raw.TRANSLATION_TERMS_PATH)) {
    issues.push("TRANSLATION_TERMS_PATH: 指定する場合は絶対パスにしてください");
  }

  const pricingConfirmedAt = new Date(`${raw.PRICING_CONFIRMED_AT}T00:00:00Z`);
  if (
    Number.isNaN(pricingConfirmedAt.getTime()) ||
    pricingConfirmedAt.toISOString().slice(0, 10) !== raw.PRICING_CONFIRMED_AT ||
    pricingConfirmedAt.getTime() > now.getTime() ||
    daysBetween(pricingConfirmedAt, now) > raw.PRICING_MAX_AGE_DAYS
  ) {
    issues.push("PRICING_CONFIRMED_AT: 料金確認日が期限切れです");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const region = raw.SONIOX_REGION as SonioxRegion;
  const endpoints = regionEndpoints[region];
  return {
    discord: {
      token: raw.DISCORD_TOKEN,
      applicationId: raw.DISCORD_APPLICATION_ID,
      allowedGuildIds,
      allowedUserIds,
    },
    soniox: {
      apiKey: raw.SONIOX_API_KEY,
      region,
      ...endpoints,
      sttModel: raw.SONIOX_STT_MODEL,
      ttsModel: raw.SONIOX_TTS_MODEL,
      voices: {
        ja: raw.SONIOX_VOICE_JA,
        ko: raw.SONIOX_VOICE_KO,
        en: raw.SONIOX_VOICE_EN,
      },
      terminationTimeoutMs: raw.SONIOX_TERMINATION_TIMEOUT_MS,
      projectMonthlyBudgetMicrousd: raw.SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD,
      limitCheckMaxStalenessSeconds: raw.SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS,
    },
    limits: {
      sessionMaxMinutes: raw.SESSION_MAX_MINUTES,
      maxSpeakersPerSession: 2,
      sessionIdleTimeoutSeconds: raw.SESSION_IDLE_TIMEOUT_SECONDS,
      playbackQueueMaxMs: raw.PLAYBACK_QUEUE_MAX_MS,
      utteranceMaxSourceSeconds: raw.UTTERANCE_MAX_SOURCE_SECONDS,
      ttsMaxInputCharacters: raw.TTS_MAX_INPUT_CHARACTERS,
      voiceReconnectTimeoutMs: raw.VOICE_RECONNECT_TIMEOUT_MS,
      userMonthlyCostMicrousd: raw.USER_MONTHLY_COST_LIMIT_MICROUSD,
      guildMonthlyCostMicrousd: raw.GUILD_MONTHLY_COST_LIMIT_MICROUSD,
      globalMonthlyCostMicrousd: raw.GLOBAL_MONTHLY_COST_LIMIT_MICROUSD,
    },
    pricing: {
      sttMicrousdPerHour: raw.STT_COST_MICROUSD_PER_HOUR,
      ttsMicrousdPerHour: raw.TTS_COST_MICROUSD_PER_HOUR,
      textMicrousdPerMillionCharactersUpperBound:
        raw.TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND,
      safetyPercent: raw.COST_ESTIMATE_SAFETY_PERCENT,
      confirmedAt: raw.PRICING_CONFIRMED_AT,
      maxAgeDays: raw.PRICING_MAX_AGE_DAYS,
    },
    usage: {
      reconcileIntervalSeconds: raw.USAGE_RECONCILE_INTERVAL_SECONDS,
      reconcileMaxStalenessSeconds: raw.USAGE_RECONCILE_MAX_STALENESS_SECONDS,
    },
    storage: {
      sqlitePath: raw.SQLITE_PATH,
      ...(raw.TRANSLATION_TERMS_PATH
        ? { translationTermsPath: raw.TRANSLATION_TERMS_PATH }
        : {}),
    },
    logIdHmacKey: raw.LOG_ID_HMAC_KEY,
  };
}
