import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  openPrivateSttCaptureFactory,
} from "../src/diagnostics/private-stt-capture.js";

async function privateDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

void test("Discord受信音声とSoniox tokenをDiscord識別子なしのowner-only fileへ分離保存する", async (context) => {
  const root = await privateDirectory("discord-translate-private-capture-");
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true }));
  });
  const factory = await openPrivateSttCaptureFactory(root);
  assert.ok(factory);
  const session = await factory.createSession({
    pair: "ja-ko",
    startedAtMonotonicMs: 90,
  });
  const speaker = session.createSpeaker();
  speaker.speakingStarted({ turnId: "opaque-turn-1", atMonotonicMs: 90 });
  const packetSequence = speaker.recordOpusPacket({
    turnId: "opaque-turn-1",
    atMonotonicMs: 100,
    packet: Buffer.from([0x11, 0x22, 0x33]),
  });
  assert.equal(packetSequence, 0);
  const stereoPcm = Buffer.alloc(8);
  stereoPcm.writeInt16LE(1_000, 0);
  stereoPcm.writeInt16LE(1_000, 2);
  stereoPcm.writeInt16LE(-1_000, 4);
  stereoPcm.writeInt16LE(-1_000, 6);
  const monoPcm = Buffer.alloc(4);
  monoPcm.writeInt16LE(1_000, 0);
  monoPcm.writeInt16LE(-1_000, 2);
  speaker.recordDecodedPacket({
    packetSequence,
    atMonotonicMs: 110,
    stereoPcm,
    monoPcm,
  });
  speaker.recordSonioxAudio({
    kind: "decoded_packet",
    packetSequence,
    turnId: "opaque-turn-1",
    atMonotonicMs: 111,
    monoPcm,
  });
  const trailingSilence = Buffer.alloc(48_000 * 2 * 0.2);
  speaker.recordSonioxAudio({
    kind: "trailing_silence",
    turnId: "opaque-turn-1",
    atMonotonicMs: 124,
    monoPcm: trailingSilence,
  });
  speaker.speakingEnded({ turnId: "opaque-turn-1", atMonotonicMs: 120 });
  speaker.recordFinalizeRequested({
    reason: "speaking_end",
    turnId: "opaque-turn-1",
    atMonotonicMs: 125,
  });
  speaker.recordSttResult({
    turnId: "opaque-turn-1",
    atMonotonicMs: 130,
    tokens: [
      {
        text: "synthetic-original",
        is_final: true,
        language: "ko",
        translation_status: "original",
        confidence: 0.9,
      },
      {
        text: "synthetic-translation",
        confidence: 0.8,
        is_final: true,
        language: "ja",
        source_language: "ko",
        translation_status: "translation",
      },
      {
        text: "synthetic-interim",
        confidence: 0.7,
        is_final: false,
        language: "ko",
        translation_status: "original",
      },
    ],
  });
  await session.close();

  const [captureDirectoryName] = await readdir(root);
  assert.ok(captureDirectoryName);
  const captureDirectory = path.join(root, captureDirectoryName);
  assert.equal((await stat(captureDirectory)).mode & 0o777, 0o700);
  const files = await readdir(captureDirectory);
  assert.deepEqual(files.sort(), [
    "session.json",
    "speaker-01-decoded-mono.pcm",
    "speaker-01-events.jsonl",
    "speaker-01-opus.bin",
    "speaker-01-results.jsonl",
    "speaker-01-soniox-input.pcm",
    "speaker-01-stereo.pcm",
  ]);
  for (const file of files) {
    assert.equal((await stat(path.join(captureDirectory, file))).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    await readFile(path.join(captureDirectory, "speaker-01-opus.bin")),
    Buffer.from([0x11, 0x22, 0x33]),
  );
  assert.deepEqual(
    await readFile(path.join(captureDirectory, "speaker-01-stereo.pcm")),
    stereoPcm,
  );
  assert.deepEqual(
    await readFile(path.join(captureDirectory, "speaker-01-decoded-mono.pcm")),
    monoPcm,
  );
  assert.deepEqual(
    await readFile(path.join(captureDirectory, "speaker-01-soniox-input.pcm")),
    Buffer.concat([monoPcm, trailingSilence]),
  );
  const events = (await readFile(
    path.join(captureDirectory, "speaker-01-events.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.kind), [
    "speaking_start",
    "opus_packet",
    "decoded_packet",
    "soniox_audio_sent",
    "soniox_audio_sent",
    "speaking_end",
    "manual_finalize_requested",
  ]);
  assert.deepEqual(events[1], {
    kind: "opus_packet",
    turn_id: "opaque-turn-1",
    at_ms: 10,
    packet_sequence: 0,
    opus_offset: 0,
    opus_byte_length: 3,
  });
  assert.deepEqual(events[2], {
    kind: "decoded_packet",
    packet_sequence: 0,
    at_ms: 20,
    stereo_offset: 0,
    stereo_byte_length: 8,
    mono_offset: 0,
    mono_byte_length: 4,
  });
  assert.deepEqual(events[3], {
    kind: "soniox_audio_sent",
    audio_kind: "decoded_packet",
    turn_id: "opaque-turn-1",
    at_ms: 21,
    packet_sequence: 0,
    soniox_offset: 0,
    soniox_byte_length: 4,
  });
  assert.deepEqual(events[4], {
    kind: "soniox_audio_sent",
    audio_kind: "trailing_silence",
    turn_id: "opaque-turn-1",
    at_ms: 34,
    soniox_offset: 4,
    soniox_byte_length: trailingSilence.length,
  });
  const [result] = (await readFile(
    path.join(captureDirectory, "speaker-01-results.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(result, {
    turn_id: "opaque-turn-1",
    at_ms: 40,
    original_tokens: [{
      text: "synthetic-original",
      is_final: true,
      language: "ko",
      confidence: 0.9,
    }, {
      text: "synthetic-interim",
      is_final: false,
      language: "ko",
      confidence: 0.7,
    }],
    translation_tokens: [{
      text: "synthetic-translation",
      is_final: true,
      language: "ja",
      source_language: "ko",
      confidence: 0.8,
    }],
    other_tokens: [],
  });
  const serialized = JSON.stringify({ events, result });
  assert.doesNotMatch(serialized, /user_id|guild_id|discord/i);
});

void test("private STT captureは0700でないdirectoryとsymbolic linkを拒否する", async (context) => {
  const parent = await privateDirectory("discord-translate-private-capture-invalid-");
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(parent, { recursive: true }));
  });
  const publicDirectory = path.join(parent, "public");
  await import("node:fs/promises").then(({ mkdir, chmod }) =>
    mkdir(publicDirectory).then(() => chmod(publicDirectory, 0o755))
  );
  await assert.rejects(
    openPrivateSttCaptureFactory(publicDirectory),
    /0700/u,
  );

  const privateRoot = path.join(parent, "private");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(privateRoot, { mode: 0o700 }));
  const linked = path.join(parent, "linked");
  await symlink(privateRoot, linked, "dir");
  await assert.rejects(
    openPrivateSttCaptureFactory(linked),
    /symbolic link/u,
  );

  const repositoryDirectory = await mkdtemp(
    path.join(import.meta.dirname, "private-capture-invalid-"),
  );
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(repositoryDirectory, { recursive: true })
    );
  });
  await assert.rejects(
    openPrivateSttCaptureFactory(repositoryDirectory),
    /.data\/stt-eval/u,
  );
});
