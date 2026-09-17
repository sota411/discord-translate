import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { VoiceReceiver, type VoiceConnection } from "@discordjs/voice";
import { REST } from "discord.js";

import { loadConfig } from "../src/config.js";
import {
  DiscordTranslationRuntime,
  type TranslationRuntimeOptions,
} from "../src/discord/translation-driver.js";
import { openPrivateSttCaptureFactory } from "../src/diagnostics/private-stt-capture.js";
import { validEnv } from "./helpers/valid-env.js";

const userId = "323456789012345678";
const otherUserId = "423456789012345678";
const key = Buffer.alloc(32, 7); // Synthetic test key, never used on a connection.
const payload = Buffer.from([0xf8, 0xff, 0xfe]);

function encryptedPacket(sequence: number, timestamp: number, ssrc = 123): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x78;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(timestamp);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(payload), cipher.final(), cipher.getAuthTag(), nonce.subarray(0, 4)]);
}

void test("実SDKが受理したRTPだけを同じOpusのprivate captureへ対応付ける", async (context) => {
  for (const enabled of [true, false]) {
    const root = await mkdtemp(path.join(tmpdir(), "stt-rtp-capture-"));
    context.after(() => rm(root, { recursive: true }));
    const startedAtMonotonicMs = performance.now();
    const factory = await openPrivateSttCaptureFactory(enabled ? root : undefined);
    const capture = await factory?.createSession({ pair: "ja-ko", startedAtMonotonicMs });
    const receiver = new VoiceReceiver({ state: { status: "connecting" } } as VoiceConnection);
    receiver.connectionData = {
      encryptionMode: "aead_aes256_gcm_rtpsize",
      nonceBuffer: Buffer.alloc(12),
      secretKey: key,
    };
    receiver.ssrcMap.update({ userId, audioSSRC: 123 });
    receiver.ssrcMap.update({ userId: otherUserId, audioSSRC: 456 });
    const connection = new EventEmitter();
    const stt = new EventEmitter();
    const audio: Buffer[] = [];
    Object.assign(stt, {
      connect: () => Promise.resolve(), close: () => undefined,
      sendAudio: (pcm: Buffer) => audio.push(Buffer.from(pcm)),
      finalize: () => undefined, keepAlive: () => undefined,
    });
    const failures: string[] = [];
    const warnings: string[] = [];
    const runtime = new DiscordTranslationRuntime({
      session: { sessionId: "rtp", guildId: "223456789012345678", voiceChannelId: "voice",
        voiceChannelName: "Test", textChannelId: "text", textChannelName: "test", startedByUserId: userId,
        pair: "ja-ko", state: "ACTIVE", startedAt: new Date(), participantIds: [userId],
        playbackMode: "conversation", audioEnabled: false, captionFailurePolicy: "continue_audio" },
      participantIds: [userId], translationTerms: [],
      guild: { client: { rest: new REST({ hashSweepInterval: 0, handlerSweepInterval: 0 }) },
        members: { cache: new Map([[userId, { displayName: "Test" }]]) } },
      voiceChannel: { members: new Map([[userId, { user: { bot: false } }]]) },
      presentation: { threadId: "rtp", captionChannel: { send: () => Promise.resolve({
        edit: () => Promise.resolve(), delete: () => Promise.resolve(),
      }) }, update: () => Promise.resolve(), close: () => Promise.resolve() },
      connection: { receiver, subscribe: () => undefined, on: connection.on.bind(connection), destroy: () => undefined },
      config: loadConfig(validEnv({ SONIOX_REGION: "jp" }), new Date("2026-08-15T00:00:00Z")),
      speakerLanguageHints: new Map(),
      ...(capture ? { privateCapture: capture } : {}),
      ledger: { openProviderRequest: () => undefined, recordProviderUsage: () => undefined,
        finishProviderRequest: () => undefined, finishSession: () => undefined },
      sttFactory: { create: () => ({ session: stt, initialTextCharacterCount: 0 }) },
      tts: {}, latency: { start: () => undefined, mark: () => undefined, finish: () => undefined },
      observeFlow: () => undefined,
      onFailure: (_guild: string, reason: string) => failures.push(reason),
      onWarning: (_guild: string, operation: string) => warnings.push(operation),
    } as unknown as TranslationRuntimeOptions);
    try {
      // Actual AEAD decryption; no parsePacket/decrypt mock. The first packet opens the speaker.
      receiver.onUdpMessage(encryptedPacket(65_535, 0xffff_fc40));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stream = receiver.subscriptions.get(userId);
      assert.ok(stream);
      stream.pause();
      receiver.onUdpMessage(encryptedPacket(0, 0));
      receiver.onUdpMessage(encryptedPacket(1, 960));
      receiver.onUdpMessage(encryptedPacket(9, 8_640, 456));
      stream.resume();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(audio.length, 3);

      const corrupted = encryptedPacket(2, 1_920);
      corrupted[12] = (corrupted[12] ?? 0) ^ 1;
      receiver.onUdpMessage(corrupted);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const recovered = receiver.subscriptions.get(userId);
      assert.ok(recovered);
      assert.notEqual(recovered, stream);
      receiver.onUdpMessage(encryptedPacket(3, 2_880));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(failures, []);
      assert.deepEqual(warnings, ["voice_receive_stream_recovering"]);
      assert.equal(receiver.subscriptions.has(otherUserId), false);
    } finally {
      await runtime.stop("TEST_COMPLETE");
    }
    const directories = await readdir(root);
    if (!enabled) { assert.deepEqual(directories, []); continue; }
    assert.equal(directories.length, 1);
    const directoryName = directories[0];
    assert.ok(directoryName);
    const directory = path.join(root, directoryName);
    const events = (await readFile(path.join(directory, "speaker-01-events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const packets = events.filter(event => event.kind === "opus_packet");
    assert.equal(packets.length, 4, "exclude the other speaker and the authentication failure");
    assert.deepEqual(packets.map(event => event.rtp_sequence), [65_535, 0, 1, 3]);
    assert.deepEqual(packets.map(event => event.rtp_timestamp), [0xffff_fc40, 0, 960, 2_880]);
    assert.deepEqual(packets.map(event => event.rtp_ssrc), [123, 123, 123, 123]);
    const bytes = await readFile(path.join(directory, "speaker-01-opus.bin"));
    for (const [index, packet] of packets.entries()) {
      assert.equal(packet.packet_sequence, index);
      assert.equal(packet.opus_offset, index * payload.length);
      assert.ok(typeof packet.rtp_received_at_ms === "number" && packet.rtp_received_at_ms >= 0);
      assert.ok(packet.rtp_received_at_ms <= Number(packet.at_ms));
      const saved = bytes.subarray(packet.opus_offset, packet.opus_offset + Number(packet.opus_byte_length));
      assert.equal(createHash("sha256").update(saved).digest("hex"), createHash("sha256").update(payload).digest("hex"));
    }
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`${userId}|${otherUserId}`));
  }
});
