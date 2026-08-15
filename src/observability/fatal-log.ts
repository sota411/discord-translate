import { ConfigError } from "../config.js";

export type FatalLogRecord = {
  timestamp: string;
  level: "error";
  event: string;
  error_name: string;
  config_issues?: readonly string[];
};

export function createFatalLogRecord(
  event: string,
  error: unknown,
  now: Date = new Date(),
): FatalLogRecord {
  const record: FatalLogRecord = {
    timestamp: now.toISOString(),
    level: "error",
    event,
    error_name: error instanceof Error ? error.name : "UnknownError",
  };
  if (error instanceof ConfigError) {
    record.config_issues = error.issues;
  }
  return record;
}
