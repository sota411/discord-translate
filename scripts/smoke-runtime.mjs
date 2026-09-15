import opus from "@discordjs/opus";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { DolphinWorker } from "../dist/audio/dolphin-worker.js";

await import("../dist/discord/translation-driver.js");

const database = new Database(":memory:");
const encoder = new opus.OpusEncoder(48_000, 2);
const result = {
  sqlite: database.open,
  opus: typeof encoder.decode === "function",
};
database.close();

if (!result.sqlite || !result.opus) throw new Error("native module smoke check failed");
if (process.argv[2] === "--dolphin") {
  const worker = await DolphinWorker.start();
  try {
    assert.equal(await worker.transcribe(Buffer.alloc(96_000)), "");
    result.dolphin = true;
  } finally {
    await worker.close();
  }
}
globalThis.console.log(JSON.stringify(result));
