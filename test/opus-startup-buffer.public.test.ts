import assert from "node:assert/strict";
import { test } from "node:test";

import { OpusStartupBuffer } from "../src/audio/opus-startup-buffer.js";

void test("STT接続待ちOpus bufferは件数とbyte数を超えて保持しない", () => {
  const buffer = new OpusStartupBuffer({ maxPackets: 2, maxBytes: 5 });

  assert.equal(buffer.enqueue(Buffer.from([1, 2])), true);
  assert.equal(buffer.enqueue(Buffer.from([3, 4, 5])), true);
  assert.equal(buffer.enqueue(Buffer.from([6])), false);
  assert.deepEqual(buffer.drain(), [Buffer.from([1, 2]), Buffer.from([3, 4, 5])]);
  assert.equal(buffer.enqueue(Buffer.from([7, 8, 9, 10, 11, 12])), false);
  assert.equal(buffer.enqueue(Buffer.from([7])), true);
});
