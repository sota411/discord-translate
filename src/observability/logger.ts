import { createHmac } from "node:crypto";

import { ApplicationError } from "../domain/application-error.js";

type LogValue = string | number | boolean | null;
type LogFields = Readonly<Record<string, LogValue>>;

export type SafeLogger = {
  pseudonymize(value: string): string;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
};

function errorFields(error: unknown): LogFields {
  if (error instanceof ApplicationError) {
    return { error_name: error.name, error_code: error.code };
  }
  if (error instanceof Error) {
    return { error_name: error.name };
  }
  return { error_name: "UnknownError" };
}

export function createSafeLogger(
  hmacKey: string,
  write: (line: string) => void = console.log,
): SafeLogger {
  const emit = (level: string, event: string, fields: LogFields = {}): void => {
    write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    }));
  };
  return {
    pseudonymize: (value) => createHmac("sha256", hmacKey)
      .update(value)
      .digest("hex")
      .slice(0, 20),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, error, fields) => emit("error", event, {
      ...fields,
      ...errorFields(error),
    }),
  };
}
