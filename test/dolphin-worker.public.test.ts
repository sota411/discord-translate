import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DolphinWorker } from "../src/audio/dolphin-worker.js";

// A real child exercises framing/backpressure/lifecycle without loading an ASR model.
const peer = String.raw`
  const assert = require('node:assert/strict');
  let buffer = Buffer.alloc(0), remaining = 0, warm = true, chunks = [];
  process.stdout.write('READY\n');
  process.stdin.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const count = buffer.readUInt32LE();
      if (!remaining) {
        assert.ok(count > 0 && count <= 288000 && count % 2 === 0);
        remaining = count; buffer = buffer.subarray(4); chunks = []; continue;
      }
      assert.ok(count <= remaining && count % 2 === 0);
      assert.ok(count === 0 || count === Math.min(1920, remaining));
      if (buffer.length < 4 + count) return;
      chunks.push(buffer.subarray(4, 4 + count)); buffer = buffer.subarray(4 + count);
      if (!count) {
        remaining = 0;
        setTimeout(() => process.stdout.write('\n'), 30);
      } else {
        remaining -= count;
        if (!remaining) {
          const pcm = Buffer.concat(chunks);
          if (warm) { assert.equal(pcm.length, 288000); assert.ok(pcm.every(x => x === 0)); }
          process.stdout.write((warm ? '' : pcm.toString('hex')) + '\n'); warm = false;
        }
      }
    }
  });
`;

void test("実際の子プロセスへ分割PCMを送り、中止応答の後だけ再利用する", async () => {
  const worker = await DolphinWorker.start(process.execPath, ["-e", peer]);
  try {
    for (const length of [0, -2, 1, 288002, NaN]) assert.throws(() => worker.begin(length), TypeError);
    const job = worker.begin(6);
    let replied = false;
    void job.result.then(() => { replied = true; });
    assert.throws(() => job.push(Buffer.alloc(1)), TypeError);
    assert.throws(() => job.push(Buffer.alloc(8)), TypeError);
    job.push(Buffer.from([1, 2]));
    await delay(10);
    assert.equal(replied, false);
    assert.throws(() => worker.begin(2));
    job.push(Buffer.from([3, 4, 5, 6]));
    job.cancel(); // A completed prefix must not write a stray cancellation header.
    assert.equal(await job.result, "010203040506");
    assert.throws(() => job.push(Buffer.alloc(2)));
    const pcm = Buffer.from(Array.from({ length: 3846 }, (_, i) => i % 256));
    assert.equal(await worker.transcribe(pcm), pcm.toString("hex"));
    const fragmented = worker.begin(pcm.length);
    const first = Buffer.from(pcm.subarray(0, 2));
    fragmented.push(first);
    first.fill(0); // Buffered input must not retain the caller's mutable storage.
    for (const [start, end] of [[2, 1000], [1000, 3000], [3000, 3846]]) {
      fragmented.push(pcm.subarray(start, end));
    }
    assert.equal(await fragmented.result, pcm.toString("hex"));
    const cancelled = worker.begin(230400);
    cancelled.push(Buffer.alloc(1922)); // Cancel with a partial frame buffered.
    cancelled.cancel();
    cancelled.cancel();
    assert.throws(() => worker.begin(2));
    assert.equal(await cancelled.result, "");
    assert.equal(await worker.transcribe(Buffer.from([7, 8])), "0708");
    const closing = worker.begin(4);
    closing.push(Buffer.alloc(2));
    const rejected = assert.rejects(closing.result, { name: "AbortError" });
    await worker.close();
    await rejected;
  } finally { await worker.close(); }
});
