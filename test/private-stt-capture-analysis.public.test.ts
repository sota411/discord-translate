import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  analyzePrivateSttCapture,
} from "../src/diagnostics/private-stt-capture-analysis.js";
import {
  openPrivateSttCaptureFactory,
} from "../src/diagnostics/private-stt-capture.js";

const execFileAsync = promisify(execFile);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

void test("保存後のDiscord音声を本文なしの数値指標へ解析する", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "discord-translate-capture-analysis-"));
  await chmod(root, 0o700);
  context.after(async () => await rm(root, { recursive: true }));

  const factory = await openPrivateSttCaptureFactory(root);
  assert.ok(factory);
  const session = await factory.createSession({
    pair: "ja-ko",
    startedAtMonotonicMs: 90,
  });
  const speaker = session.createSpeaker();
  speaker.speakingStarted({ turnId: "opaque-turn", atMonotonicMs: 95 });

  const firstPacket = Buffer.from([0x11, 0x22]);
  const firstSequence = speaker.recordOpusPacket({
    turnId: "opaque-turn",
    atMonotonicMs: 100,
    packet: firstPacket,
  });
  const stereoPcm = Buffer.alloc(16);
  const stereoSamples = [
    [1_000, 1_000],
    [-1_000, -1_000],
    [2_000, -2_000],
    [0, 0],
  ] as const;
  stereoSamples.forEach(([left, right], index) => {
    stereoPcm.writeInt16LE(left, index * 4);
    stereoPcm.writeInt16LE(right, index * 4 + 2);
  });
  const monoPcm = Buffer.alloc(8);
  [1_000, -1_000, 0, 0].forEach((sample, index) => {
    monoPcm.writeInt16LE(sample, index * 2);
  });
  speaker.recordDecodedPacket({
    packetSequence: firstSequence,
    atMonotonicMs: 110,
    stereoPcm,
    monoPcm,
  });
  speaker.recordSonioxAudio({
    kind: "decoded_packet",
    packetSequence: firstSequence,
    turnId: "opaque-turn",
    atMonotonicMs: 111,
    monoPcm,
  });

  const droppedPacket = Buffer.from([0x33]);
  const droppedSequence = speaker.recordOpusPacket({
    turnId: "opaque-turn",
    atMonotonicMs: 125,
    packet: droppedPacket,
  });
  speaker.recordDroppedPacket({
    packetSequence: droppedSequence,
    atMonotonicMs: 126,
  });
  speaker.recordReceiveEvent({
    kind: "receive_stream_closed",
    turnId: "opaque-turn",
    atMonotonicMs: 130,
  });
  speaker.recordReceiveEvent({
    kind: "receive_stream_recovered",
    turnId: "opaque-turn",
    atMonotonicMs: 180,
  });
  speaker.speakingEnded({ turnId: "opaque-turn", atMonotonicMs: 190 });
  const trailingSilence = Buffer.alloc(48_000 * 2 * 0.2);
  speaker.recordSonioxAudio({
    kind: "trailing_silence",
    turnId: "opaque-turn",
    atMonotonicMs: 194,
    monoPcm: trailingSilence,
  });
  speaker.recordFinalizeRequested({
    reason: "speaking_end",
    turnId: "opaque-turn",
    atMonotonicMs: 195,
  });
  speaker.recordSttBoundary({
    kind: "endpoint",
    turnId: "opaque-turn",
    atMonotonicMs: 200,
  });
  speaker.recordSttBoundary({
    kind: "finalized",
    turnId: "opaque-turn",
    atMonotonicMs: 201,
  });
  speaker.recordSttResult({
    turnId: "opaque-turn",
    atMonotonicMs: 195,
    tokens: [
      {
        text: "private-original",
        confidence: 0.9,
        is_final: true,
        translation_status: "original",
      },
      {
        text: "private-translation",
        confidence: 0.8,
        is_final: true,
        translation_status: "translation",
      },
    ],
  });
  await session.close();

  const [captureDirectoryName] = await readdir(root);
  assert.ok(captureDirectoryName);
  const captureDirectory = path.join(root, captureDirectoryName);
  const analysis = await analyzePrivateSttCapture(captureDirectory);

  assert.equal(analysis.version, 1);
  assert.equal(analysis.sample_rate, 48_000);
  assert.equal(analysis.speakers.length, 1);
  const [result] = analysis.speakers;
  assert.ok(result);
  assert.equal(result.speaker, "speaker-01");
  assert.deepEqual(result.opus, {
    byte_length: 3,
    packet_count: 2,
    sha256: sha256(Buffer.concat([firstPacket, droppedPacket])),
  });
  assert.equal(result.stereo_pcm.sha256, sha256(stereoPcm));
  assert.equal(result.decoded_mono_pcm.sha256, sha256(monoPcm));
  assert.equal(
    result.soniox_mono_pcm.sha256,
    sha256(Buffer.concat([monoPcm, trailingSilence])),
  );
  assert.equal(result.stereo_pcm.frame_count, 4);
  assert.equal(result.decoded_mono_pcm.sample_count, 4);
  assert.equal(result.soniox_mono_pcm.sample_count, 4 + trailingSilence.length / 2);
  assert.equal(result.channel_comparison.correlation, -0.333333);
  assert.equal(result.channel_comparison.downmix_mismatch_sample_count, 0);
  assert.deepEqual(result.transport, {
    decoded_packet_count: 1,
    decode_failed_packet_count: 1,
    unprocessed_packet_count: 0,
    maximum_receive_to_decode_ms: 10,
    maximum_packet_arrival_gap_ms: 25,
    maximum_unexplained_arrival_gap_ms: 24.917,
    receive_stream_close_count: 1,
    receive_stream_recovery_count: 1,
    maximum_receive_recovery_ms: 50,
    soniox_audio_chunk_count: 2,
    trailing_silence_chunk_count: 1,
  });
  assert.deepEqual(result.segmentation, {
    speaking_segment_count: 1,
    speaking_end_count: 1,
    manual_finalize_request_count: 1,
    manual_finalize_requests_by_reason: {
      speaking_end: 1,
      transcript_inactivity: 0,
      max_turn_duration: 0,
    },
    stt_endpoint_count: 1,
    stt_finalized_count: 1,
    stt_endpoint_after_speaking_end_ms: {
      observation_count: 1,
      mean: 10,
      p50: 10,
      p95: 10,
      maximum: 10,
    },
    stt_endpoint_without_prior_speaking_end_count: 0,
    maximum_speaking_start_to_first_packet_ms: 5,
    maximum_last_packet_to_speaking_end_ms: 65,
  });
  assert.deepEqual(result.tokens, {
    result_count: 1,
    original_token_count: 1,
    translation_token_count: 1,
    other_token_count: 0,
  });
  assert.doesNotMatch(JSON.stringify(analysis), /private-original|private-translation/u);

  const projectRoot = path.resolve(import.meta.dirname, "..");
  const cli = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(projectRoot, "src/analyze-private-stt-capture.ts"),
      captureDirectory,
    ],
    { cwd: projectRoot },
  );
  assert.equal(cli.stderr, "");
  assert.deepEqual(JSON.parse(cli.stdout) as unknown, analysis);
  assert.doesNotMatch(cli.stdout, /private-original|private-translation/u);

  assert.deepEqual(
    await readFile(path.join(captureDirectory, "speaker-01-soniox-input.pcm")),
    Buffer.concat([monoPcm, trailingSilence]),
  );

  const privateMalformedText = "private-error-content-must-not-leak";
  await appendFile(
    path.join(captureDirectory, "speaker-01-results.jsonl"),
    `{"text":"${privateMalformedText}"`,
  );
  await assert.rejects(
    analyzePrivateSttCapture(captureDirectory),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("JSONとして解析できません") &&
      !error.message.includes(privateMalformedText),
  );
});
