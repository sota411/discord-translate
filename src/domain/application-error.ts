export const errorCodes = [
  "GUILD_REQUIRED",
  "GUILD_NOT_ALLOWED",
  "USER_NOT_ALLOWED",
  "SPEAKER_NOT_ALLOWED",
  "VOICE_REQUIRED",
  "TOO_MANY_SPEAKERS",
  "BOT_PERMISSION_MISSING",
  "SESSION_ALREADY_ACTIVE",
  "SESSION_NOT_ACTIVE",
  "STOP_NOT_ALLOWED",
  "USAGE_LIMIT_REACHED",
  "USAGE_LEDGER_UNAVAILABLE",
  "USAGE_RECONCILIATION_STALE",
  "SONIOX_CAPACITY_UNAVAILABLE",
  "UNSUPPORTED_PAIR",
  "SESSION_START_FAILED",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class ApplicationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    public readonly publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "ApplicationError";
  }
}
