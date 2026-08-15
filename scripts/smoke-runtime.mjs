import opus from "@discordjs/opus";
import Database from "better-sqlite3";

await import("../dist/discord/translation-driver.js");

const database = new Database(":memory:");
const encoder = new opus.OpusEncoder(48_000, 2);
const result = {
  sqlite: database.open,
  opus: typeof encoder.decode === "function",
};
database.close();

if (!result.sqlite || !result.opus) throw new Error("native module smoke check failed");
globalThis.console.log(JSON.stringify(result));
