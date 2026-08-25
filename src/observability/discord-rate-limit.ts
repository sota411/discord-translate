export type DiscordRateLimitData = {
  global: boolean;
  hash: string;
  limit: number;
  majorParameter: string;
  method: string;
  retryAfter: number;
  route: string;
  scope: "global" | "shared" | "user";
  sublimitTimeout: number;
  timeToReset: number;
  url: string;
};

export type SafeDiscordRateLimitFields = {
  global: boolean;
  limit: number;
  method: string;
  retry_after_ms: number;
  scope: "global" | "shared" | "user";
  sublimit_timeout_ms: number;
  time_to_reset_ms: number;
};

export function safeDiscordRateLimitFields(
  input: DiscordRateLimitData,
): SafeDiscordRateLimitFields {
  return {
    global: input.global,
    limit: input.limit,
    method: input.method,
    retry_after_ms: input.retryAfter,
    scope: input.scope,
    sublimit_timeout_ms: input.sublimitTimeout,
    time_to_reset_ms: input.timeToReset,
  };
}
