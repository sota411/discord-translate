import { startApplication } from "./app.js";

function fatal(event: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    error_name: errorName,
  }));
}

try {
  const application = await startApplication();
  const shutdown = (signal: NodeJS.Signals): void => {
    void application.shutdown(signal)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        fatal("application_shutdown_failed", error);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  fatal("application_start_failed", error);
  process.exitCode = 1;
}
