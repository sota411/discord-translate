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

void test("診断時はSTT接続前に受信したpacketのcapture順を保持する", () => {
  const buffer = new OpusStartupBuffer({ maxPackets: 2, maxBytes: 5 });
  const packet = Buffer.from([1, 2]);

  assert.equal(buffer.enqueue(packet, {
    captureSequence: 7,
  }), true);
  packet[0] = 9;

  assert.deepEqual(buffer.drainEntries(), [{
    packet: Buffer.from([1, 2]),
    metadata: {
      captureSequence: 7,
    },
  }]);
  assert.deepEqual(buffer.drainEntries(), []);
});
