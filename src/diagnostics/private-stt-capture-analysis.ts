import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  isLanguagePair,
  type LanguagePair,
} from "../domain/language-pair.js";
import { validatePrivateSttCaptureDirectory } from "./private-stt-capture.js";

const privateFileMode = 0o600;
const pcmFullScale = 32_768;
const pcmFrameSamples = 960;
const lowEnergyThreshold = pcmFullScale * 10 ** (-50 / 20);
const audioReadChunkBytes = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

type SignalMetrics = {
  rms_dbfs: number | null;
  peak_dbfs: number | null;
  clipped_sample_ratio: number;
  low_energy_20ms_frame_ratio_below_minus_50_dbfs: number;
};

type MonoPcmMetrics = {
  byte_length: number;
  sample_count: number;
  duration_ms: number;
  sha256: string;
  signal: SignalMetrics;
};

type SignalAccumulator = {
  sampleCount: number;
  squareSum: number;
  peak: number;
  clippedSampleCount: number;
  frameSquareSum: number;
  frameSampleCount: number;
  frameCount: number;
  lowEnergyFrameCount: number;
};

type OpusPacketEvent = {
  sequence: number;
  atMs: number;
  offset: number;
  byteLength: number;
};

type DecodedPacketEvent = {
  sequence: number;
  atMs: number;
  stereoOffset: number;
  stereoByteLength: number;
  monoOffset: number;
  monoByteLength: number;
};

type SonioxAudioEvent = {
  audioKind: "decoded_packet" | "trailing_silence";
  packetSequence?: number;
  offset: number;
  byteLength: number;
};

type CaptureEventSummary = {
  opusPackets: OpusPacketEvent[];
  decodedPackets: DecodedPacketEvent[];
  sonioxAudioChunks: SonioxAudioEvent[];
  decodeFailedSequences: Set<number>;
  speakingSegmentCount: number;
  speakingEndCount: number;
  manualFinalizeRequestCount: number;
  manualFinalizeRequestsByReason: {
    speaking_end: number;
    transcript_inactivity: number;
    max_turn_duration: number;
  };
  sttEndpointCount: number;
  sttFinalizedCount: number;
  sttEndpointAfterSpeakingEndMs: number[];
  sttEndpointWithoutPriorSpeakingEndCount: number;
  maximumSpeakingStartToFirstPacketMs: number | null;
  maximumLastPacketToSpeakingEndMs: number | null;
  receiveStreamCloseCount: number;
  receiveStreamRecoveryCount: number;
  maximumReceiveRecoveryMs: number | null;
};

export type PrivateSttCaptureAnalysis = {
  version: 1;
  pair: LanguagePair;
  sample_rate: number;
  speakers: {
    speaker: string;
    opus: {
      byte_length: number;
      packet_count: number;
      sha256: string;
    };
    stereo_pcm: {
      byte_length: number;
      frame_count: number;
      duration_ms: number;
      sha256: string;
      left: SignalMetrics;
      right: SignalMetrics;
    };
    decoded_mono_pcm: MonoPcmMetrics;
    soniox_mono_pcm: MonoPcmMetrics;
    channel_comparison: {
      correlation: number | null;
      left_to_right_rms_db: number | null;
      mono_to_louder_channel_rms_db: number | null;
      downmix_mismatch_sample_count: number;
    };
    transport: {
      decoded_packet_count: number;
      decode_failed_packet_count: number;
      unprocessed_packet_count: number;
      maximum_receive_to_decode_ms: number | null;
      maximum_packet_arrival_gap_ms: number | null;
      maximum_unexplained_arrival_gap_ms: number | null;
      receive_stream_close_count: number;
      receive_stream_recovery_count: number;
      maximum_receive_recovery_ms: number | null;
      soniox_audio_chunk_count: number;
      trailing_silence_chunk_count: number;
    };
    segmentation: {
      speaking_segment_count: number;
      speaking_end_count: number;
      manual_finalize_request_count: number;
      manual_finalize_requests_by_reason: {
        speaking_end: number;
        transcript_inactivity: number;
        max_turn_duration: number;
      };
      stt_endpoint_count: number;
      stt_finalized_count: number;
      stt_endpoint_after_speaking_end_ms: DurationSummary | null;
      stt_endpoint_without_prior_speaking_end_count: number;
      maximum_speaking_start_to_first_packet_ms: number | null;
      maximum_last_packet_to_speaking_end_ms: number | null;
    };
    tokens: {
      result_count: number;
      original_token_count: number;
      translation_token_count: number;
      other_token_count: number;
    };
  }[];
};

type DurationSummary = {
  observation_count: number;
  mean: number;
  p50: number;
  p95: number;
  maximum: number;
};

function emptySignalAccumulator(): SignalAccumulator {
  return {
    sampleCount: 0,
    squareSum: 0,
    peak: 0,
    clippedSampleCount: 0,
    frameSquareSum: 0,
    frameSampleCount: 0,
    frameCount: 0,
    lowEnergyFrameCount: 0,
  };
}

function finishFrame(accumulator: SignalAccumulator): void {
  if (accumulator.frameSampleCount === 0) return;
  const rms = Math.sqrt(
    accumulator.frameSquareSum / accumulator.frameSampleCount,
  );
  accumulator.frameCount += 1;
  if (rms < lowEnergyThreshold) accumulator.lowEnergyFrameCount += 1;
  accumulator.frameSquareSum = 0;
  accumulator.frameSampleCount = 0;
}

function addSample(accumulator: SignalAccumulator, sample: number): void {
  const absolute = Math.abs(sample);
  accumulator.sampleCount += 1;
  accumulator.squareSum += sample * sample;
  accumulator.peak = Math.max(accumulator.peak, absolute);
  if (absolute >= 32_767) accumulator.clippedSampleCount += 1;
  accumulator.frameSquareSum += sample * sample;
  accumulator.frameSampleCount += 1;
  if (accumulator.frameSampleCount === pcmFrameSamples) finishFrame(accumulator);
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 6);
}

function amplitudeDbfs(amplitude: number): number | null {
  return amplitude === 0 ? null : round(20 * Math.log10(amplitude / pcmFullScale));
}

function rms(accumulator: SignalAccumulator): number {
  return accumulator.sampleCount === 0
    ? 0
    : Math.sqrt(accumulator.squareSum / accumulator.sampleCount);
}

function signalMetrics(accumulator: SignalAccumulator): SignalMetrics {
  finishFrame(accumulator);
  return {
    rms_dbfs: amplitudeDbfs(rms(accumulator)),
    peak_dbfs: amplitudeDbfs(accumulator.peak),
    clipped_sample_ratio: ratio(
      accumulator.clippedSampleCount,
      accumulator.sampleCount,
    ),
    low_energy_20ms_frame_ratio_below_minus_50_dbfs: ratio(
      accumulator.lowEnergyFrameCount,
      accumulator.frameCount,
    ),
  };
}

function asRecord(value: unknown, description: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description}はJSON objectである必要があります`);
  }
  return value as JsonRecord;
}

function numberField(record: JsonRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`capture eventの${field}は有限のnumberである必要があります`);
  }
  return value;
}

function nonNegativeIntegerField(record: JsonRecord, field: string): number {
  const value = numberField(record, field);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`capture eventの${field}は0以上の整数である必要があります`);
  }
  return value;
}

function stringField(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`capture eventの${field}はstringである必要があります`);
  }
  return value;
}

async function validatePrivateFile(filePath: string): Promise<void> {
  const status = await lstat(filePath);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    (status.mode & 0o7777) !== privateFileMode
  ) {
    throw new Error(
      `${path.basename(filePath)}は所有者専用の通常file 0600である必要があります`,
    );
  }
}

async function* readJsonLines(filePath: string): AsyncGenerator<JsonRecord> {
  await validatePrivateFile(filePath);
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `${path.basename(filePath)}:${String(lineNumber)}をJSONとして解析できません`,
      );
    }
    yield asRecord(parsed, `${path.basename(filePath)}:${String(lineNumber)}`);
  }
}

async function readSessionMetadata(directoryPath: string): Promise<{
  pair: LanguagePair;
  sampleRate: number;
}> {
  const filePath = path.join(directoryPath, "session.json");
  await validatePrivateFile(filePath);
  const parsed = asRecord(
    JSON.parse(await readFile(filePath, "utf8")) as unknown,
    "session.json",
  );
  if (parsed.version !== 1) {
    throw new Error("未対応のprivate STT capture versionです");
  }
  if (typeof parsed.pair !== "string" || !isLanguagePair(parsed.pair)) {
    throw new Error("session.jsonの言語pairが不正です");
  }
  if (
    parsed.audio_format !== "pcm_s16le" ||
    parsed.sample_rate !== 48_000 ||
    parsed.decoded_channels !== 2 ||
    parsed.soniox_channels !== 1
  ) {
    throw new Error("session.jsonのPCM形式は48 kHz signed 16-bit stereo/monoである必要があります");
  }
  return { pair: parsed.pair, sampleRate: parsed.sample_rate };
}

async function readExactly(
  file: FileHandle,
  byteLength: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(byteLength);
  let bytesRead = 0;
  while (bytesRead < byteLength) {
    const result = await file.read(
      buffer,
      bytesRead,
      byteLength - bytesRead,
      position + bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead !== byteLength) {
    throw new Error("private STT capture PCMが途中で終了しています");
  }
  return buffer;
}

async function hashFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
  await validatePrivateFile(filePath);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("private STT captureはbinaryとして読み取る必要があります");
    }
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

async function analyzeMonoPcm(filePath: string): Promise<MonoPcmMetrics> {
  await validatePrivateFile(filePath);
  const file = await open(filePath, "r");
  try {
    const status = await file.stat();
    if (status.size % 2 !== 0) {
      throw new Error("private STT capture mono PCMのsample境界が不正です");
    }
    const signal = emptySignalAccumulator();
    const hash = createHash("sha256");
    let position = 0;
    while (position < status.size) {
      const byteLength = Math.min(audioReadChunkBytes, status.size - position);
      const chunk = await readExactly(file, byteLength, position);
      hash.update(chunk);
      for (let offset = 0; offset < chunk.length; offset += 2) {
        addSample(signal, chunk.readInt16LE(offset));
      }
      position += byteLength;
    }
    const sampleCount = status.size / 2;
    return {
      byte_length: status.size,
      sample_count: sampleCount,
      duration_ms: round(sampleCount / 48_000 * 1_000),
      sha256: hash.digest("hex"),
      signal: signalMetrics(signal),
    };
  } finally {
    await file.close();
  }
}

async function analyzePcm(
  stereoPath: string,
  decodedMonoPath: string,
  sonioxInputPath: string,
): Promise<{
  stereo: PrivateSttCaptureAnalysis["speakers"][number]["stereo_pcm"];
  decodedMono: MonoPcmMetrics;
  sonioxMono: MonoPcmMetrics;
  channelComparison: PrivateSttCaptureAnalysis["speakers"][number]["channel_comparison"];
}> {
  await Promise.all([
    validatePrivateFile(stereoPath),
    validatePrivateFile(decodedMonoPath),
    validatePrivateFile(sonioxInputPath),
  ]);
  const [stereoFile, monoFile] = await Promise.all([
    open(stereoPath, "r"),
    open(decodedMonoPath, "r"),
  ]);
  try {
    const [stereoStatus, monoStatus] = await Promise.all([
      stereoFile.stat(),
      monoFile.stat(),
    ]);
    if (stereoStatus.size % 4 !== 0 || monoStatus.size % 2 !== 0) {
      throw new Error("private STT capture PCMのsample境界が不正です");
    }
    if (stereoStatus.size !== monoStatus.size * 2) {
      throw new Error("stereo PCMと復号後mono PCMのsample数が一致しません");
    }

    const left = emptySignalAccumulator();
    const right = emptySignalAccumulator();
    const mono = emptySignalAccumulator();
    const stereoHash = createHash("sha256");
    const monoHash = createHash("sha256");
    let crossProductSum = 0;
    let downmixMismatchSampleCount = 0;
    let stereoPosition = 0;
    let monoPosition = 0;
    while (stereoPosition < stereoStatus.size) {
      const stereoByteLength = Math.min(
        audioReadChunkBytes,
        stereoStatus.size - stereoPosition,
      );
      const monoByteLength = stereoByteLength / 2;
      const [stereoChunk, monoChunk] = await Promise.all([
        readExactly(stereoFile, stereoByteLength, stereoPosition),
        readExactly(monoFile, monoByteLength, monoPosition),
      ]);
      stereoHash.update(stereoChunk);
      monoHash.update(monoChunk);
      for (
        let stereoOffset = 0, monoOffset = 0;
        stereoOffset < stereoChunk.length;
        stereoOffset += 4, monoOffset += 2
      ) {
        const leftSample = stereoChunk.readInt16LE(stereoOffset);
        const rightSample = stereoChunk.readInt16LE(stereoOffset + 2);
        const monoSample = monoChunk.readInt16LE(monoOffset);
        addSample(left, leftSample);
        addSample(right, rightSample);
        addSample(mono, monoSample);
        crossProductSum += leftSample * rightSample;
        if (monoSample !== Math.trunc((leftSample + rightSample) / 2)) {
          downmixMismatchSampleCount += 1;
        }
      }
      stereoPosition += stereoByteLength;
      monoPosition += monoByteLength;
    }

    const leftRms = rms(left);
    const rightRms = rms(right);
    const monoRms = rms(mono);
    const correlationDenominator = Math.sqrt(left.squareSum * right.squareSum);
    const louderChannelRms = Math.max(leftRms, rightRms);
    const frameCount = stereoStatus.size / 4;
    const durationMs = round(frameCount / 48_000 * 1_000);
    return {
      stereo: {
        byte_length: stereoStatus.size,
        frame_count: frameCount,
        duration_ms: durationMs,
        sha256: stereoHash.digest("hex"),
        left: signalMetrics(left),
        right: signalMetrics(right),
      },
      decodedMono: {
        byte_length: monoStatus.size,
        sample_count: monoStatus.size / 2,
        duration_ms: durationMs,
        sha256: monoHash.digest("hex"),
        signal: signalMetrics(mono),
      },
      sonioxMono: await analyzeMonoPcm(sonioxInputPath),
      channelComparison: {
        correlation: correlationDenominator === 0
          ? null
          : round(crossProductSum / correlationDenominator, 6),
        left_to_right_rms_db: leftRms === 0 || rightRms === 0
          ? null
          : round(20 * Math.log10(leftRms / rightRms)),
        mono_to_louder_channel_rms_db: monoRms === 0 || louderChannelRms === 0
          ? null
          : round(20 * Math.log10(monoRms / louderChannelRms)),
        downmix_mismatch_sample_count: downmixMismatchSampleCount,
      },
    };
  } finally {
    await Promise.allSettled([stereoFile.close(), monoFile.close()]);
  }
}

function updateMaximum(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.max(current, candidate);
}

function durationSummary(values: readonly number[]): DurationSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => {
    const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
    const value = sorted[index];
    if (value === undefined) throw new Error("duration percentileを計算できません");
    return value;
  };
  const maximum = sorted.at(-1);
  if (maximum === undefined) throw new Error("duration maximumを計算できません");
  return {
    observation_count: sorted.length,
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
    maximum,
  };
}

async function analyzeEvents(filePath: string): Promise<CaptureEventSummary> {
  const summary: CaptureEventSummary = {
    opusPackets: [],
    decodedPackets: [],
    sonioxAudioChunks: [],
    decodeFailedSequences: new Set<number>(),
    speakingSegmentCount: 0,
    speakingEndCount: 0,
    manualFinalizeRequestCount: 0,
    manualFinalizeRequestsByReason: {
      speaking_end: 0,
      transcript_inactivity: 0,
      max_turn_duration: 0,
    },
    sttEndpointCount: 0,
    sttFinalizedCount: 0,
    sttEndpointAfterSpeakingEndMs: [],
    sttEndpointWithoutPriorSpeakingEndCount: 0,
    maximumSpeakingStartToFirstPacketMs: null,
    maximumLastPacketToSpeakingEndMs: null,
    receiveStreamCloseCount: 0,
    receiveStreamRecoveryCount: 0,
    maximumReceiveRecoveryMs: null,
  };
  let activeSpeakingStart: number | undefined;
  let activeSpeakingFirstPacket: number | undefined;
  let activeSpeakingLastPacket: number | undefined;
  const pendingReceiveClosures: number[] = [];
  const lastSpeakingEndByTurn = new Map<string, number>();

  for await (const event of readJsonLines(filePath)) {
    const kind = stringField(event, "kind");
    switch (kind) {
      case "speaking_start": {
        const turnId = stringField(event, "turn_id");
        lastSpeakingEndByTurn.delete(turnId);
        activeSpeakingStart = numberField(event, "at_ms");
        activeSpeakingFirstPacket = undefined;
        activeSpeakingLastPacket = undefined;
        summary.speakingSegmentCount += 1;
        break;
      }
      case "speaking_end": {
        const turnId = stringField(event, "turn_id");
        const atMs = numberField(event, "at_ms");
        lastSpeakingEndByTurn.set(turnId, atMs);
        summary.speakingEndCount += 1;
        if (activeSpeakingLastPacket !== undefined) {
          summary.maximumLastPacketToSpeakingEndMs = updateMaximum(
            summary.maximumLastPacketToSpeakingEndMs,
            round(Math.max(0, atMs - activeSpeakingLastPacket)),
          );
        }
        activeSpeakingStart = undefined;
        activeSpeakingFirstPacket = undefined;
        activeSpeakingLastPacket = undefined;
        break;
      }
      case "opus_packet": {
        stringField(event, "turn_id");
        const atMs = numberField(event, "at_ms");
        summary.opusPackets.push({
          sequence: nonNegativeIntegerField(event, "packet_sequence"),
          atMs,
          offset: nonNegativeIntegerField(event, "opus_offset"),
          byteLength: nonNegativeIntegerField(event, "opus_byte_length"),
        });
        if (activeSpeakingStart !== undefined && activeSpeakingFirstPacket === undefined) {
          activeSpeakingFirstPacket = atMs;
          summary.maximumSpeakingStartToFirstPacketMs = updateMaximum(
            summary.maximumSpeakingStartToFirstPacketMs,
            round(Math.max(0, atMs - activeSpeakingStart)),
          );
        }
        if (activeSpeakingStart !== undefined) activeSpeakingLastPacket = atMs;
        break;
      }
      case "decoded_packet": {
        summary.decodedPackets.push({
          sequence: nonNegativeIntegerField(event, "packet_sequence"),
          atMs: numberField(event, "at_ms"),
          stereoOffset: nonNegativeIntegerField(event, "stereo_offset"),
          stereoByteLength: nonNegativeIntegerField(event, "stereo_byte_length"),
          monoOffset: nonNegativeIntegerField(event, "mono_offset"),
          monoByteLength: nonNegativeIntegerField(event, "mono_byte_length"),
        });
        break;
      }
      case "soniox_audio_sent": {
        stringField(event, "turn_id");
        numberField(event, "at_ms");
        const audioKind = stringField(event, "audio_kind");
        if (audioKind !== "decoded_packet" && audioKind !== "trailing_silence") {
          throw new Error("Soniox送信音声の種別が不正です");
        }
        const packetSequence = audioKind === "decoded_packet"
          ? nonNegativeIntegerField(event, "packet_sequence")
          : undefined;
        if (audioKind === "trailing_silence" && event.packet_sequence !== undefined) {
          throw new Error("終端無音にOpus packet sequenceを指定できません");
        }
        summary.sonioxAudioChunks.push({
          audioKind,
          ...(packetSequence === undefined ? {} : { packetSequence }),
          offset: nonNegativeIntegerField(event, "soniox_offset"),
          byteLength: nonNegativeIntegerField(event, "soniox_byte_length"),
        });
        break;
      }
      case "decode_failed": {
        summary.decodeFailedSequences.add(
          nonNegativeIntegerField(event, "packet_sequence"),
        );
        numberField(event, "at_ms");
        break;
      }
      case "receive_stream_closed": {
        stringField(event, "turn_id");
        pendingReceiveClosures.push(numberField(event, "at_ms"));
        summary.receiveStreamCloseCount += 1;
        break;
      }
      case "receive_stream_recovered": {
        stringField(event, "turn_id");
        const recoveredAt = numberField(event, "at_ms");
        const closedAt = pendingReceiveClosures.shift();
        if (closedAt !== undefined) {
          summary.maximumReceiveRecoveryMs = updateMaximum(
            summary.maximumReceiveRecoveryMs,
            round(Math.max(0, recoveredAt - closedAt)),
          );
        }
        summary.receiveStreamRecoveryCount += 1;
        break;
      }
      case "stt_boundary": {
        const turnId = stringField(event, "turn_id");
        const boundary = stringField(event, "boundary");
        if (boundary !== "endpoint" && boundary !== "finalized") {
          throw new Error("capture eventのSTT boundary種別が不正です");
        }
        const atMs = numberField(event, "at_ms");
        if (boundary === "endpoint") {
          const speakingEndedAt = lastSpeakingEndByTurn.get(turnId);
          if (speakingEndedAt === undefined) {
            summary.sttEndpointWithoutPriorSpeakingEndCount += 1;
          } else {
            summary.sttEndpointAfterSpeakingEndMs.push(
              round(Math.max(0, atMs - speakingEndedAt)),
            );
          }
          summary.sttEndpointCount += 1;
        } else {
          summary.sttFinalizedCount += 1;
        }
        if (lastSpeakingEndByTurn.has(turnId)) {
          lastSpeakingEndByTurn.delete(turnId);
        }
        break;
      }
      case "manual_finalize_requested": {
        stringField(event, "turn_id");
        numberField(event, "at_ms");
        const reason = stringField(event, "reason");
        if (
          reason !== "speaking_end" &&
          reason !== "transcript_inactivity" &&
          reason !== "max_turn_duration"
        ) {
          throw new Error("capture eventのmanual finalize理由が不正です");
        }
        summary.manualFinalizeRequestCount += 1;
        summary.manualFinalizeRequestsByReason[reason] += 1;
        break;
      }
      default:
        throw new Error(`未対応のprivate STT capture event kindです: ${kind}`);
    }
  }
  return summary;
}

function validatePacketOffsets(
  events: CaptureEventSummary,
  opusByteLength: number,
  stereoByteLength: number,
  monoByteLength: number,
): void {
  const packets = [...events.opusPackets].sort((left, right) => left.sequence - right.sequence);
  let expectedOpusOffset = 0;
  packets.forEach((packet, index) => {
    if (packet.sequence !== index || packet.offset !== expectedOpusOffset) {
      throw new Error("Opus packetのsequenceまたはoffsetが連続していません");
    }
    expectedOpusOffset += packet.byteLength;
  });
  if (expectedOpusOffset !== opusByteLength) {
    throw new Error("Opus packet eventとbinary fileのbyte数が一致しません");
  }

  const decoded = [...events.decodedPackets].sort(
    (left, right) => left.sequence - right.sequence,
  );
  let expectedStereoOffset = 0;
  let expectedMonoOffset = 0;
  const decodedSequences = new Set<number>();
  for (const packet of decoded) {
    if (
      decodedSequences.has(packet.sequence) ||
      packet.stereoOffset !== expectedStereoOffset ||
      packet.monoOffset !== expectedMonoOffset ||
      packet.stereoByteLength !== packet.monoByteLength * 2
    ) {
      throw new Error("decoded PCM eventのsequence、offset、channel長が不正です");
    }
    if (!packets.some(({ sequence }) => sequence === packet.sequence)) {
      throw new Error("受信記録のないOpus packetにdecoded PCMが存在します");
    }
    decodedSequences.add(packet.sequence);
    expectedStereoOffset += packet.stereoByteLength;
    expectedMonoOffset += packet.monoByteLength;
  }
  if (
    expectedStereoOffset !== stereoByteLength ||
    expectedMonoOffset !== monoByteLength
  ) {
    throw new Error("decoded PCM eventとPCM fileのbyte数が一致しません");
  }
  for (const sequence of events.decodeFailedSequences) {
    if (
      decodedSequences.has(sequence) ||
      !packets.some((packet) => packet.sequence === sequence)
    ) {
      throw new Error("decode失敗packetのsequenceが不正です");
    }
  }
}

function validateSonioxAudioOffsets(
  events: CaptureEventSummary,
  sonioxByteLength: number,
): void {
  const decodedBySequence = new Map(
    events.decodedPackets.map((packet) => [packet.sequence, packet]),
  );
  const sentDecodedSequences = new Set<number>();
  let expectedOffset = 0;
  for (const chunk of events.sonioxAudioChunks) {
    if (
      chunk.offset !== expectedOffset ||
      chunk.byteLength === 0 ||
      chunk.byteLength % 2 !== 0
    ) {
      throw new Error("Soniox送信PCM eventのoffsetまたはsample境界が不正です");
    }
    if (chunk.audioKind === "decoded_packet") {
      const packetSequence = chunk.packetSequence;
      const decoded = packetSequence === undefined
        ? undefined
        : decodedBySequence.get(packetSequence);
      if (
        packetSequence === undefined ||
        decoded === undefined ||
        sentDecodedSequences.has(packetSequence) ||
        decoded.monoByteLength !== chunk.byteLength
      ) {
        throw new Error("Soniox送信PCMとdecoded packetの対応が不正です");
      }
      sentDecodedSequences.add(packetSequence);
    }
    expectedOffset += chunk.byteLength;
  }
  if (expectedOffset !== sonioxByteLength) {
    throw new Error("Soniox送信PCM eventとPCM fileのbyte数が一致しません");
  }
  if (sentDecodedSequences.size !== events.decodedPackets.length) {
    throw new Error("Sonioxへ送信されていないdecoded packetがあります");
  }
}

function transportMetrics(
  events: CaptureEventSummary,
): PrivateSttCaptureAnalysis["speakers"][number]["transport"] {
  const packets = [...events.opusPackets].sort((left, right) => left.sequence - right.sequence);
  const decodedDurations = new Map(
    events.decodedPackets.map((packet) => [
      packet.sequence,
      packet.stereoByteLength / 4 / 48_000 * 1_000,
    ]),
  );
  let maximumGap: number | null = null;
  let maximumUnexplainedGap: number | null = null;
  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    const current = packets[index];
    if (!previous || !current) continue;
    const gap = Math.max(0, current.atMs - previous.atMs);
    maximumGap = updateMaximum(maximumGap, round(gap));
    const previousDuration = decodedDurations.get(previous.sequence);
    if (previousDuration !== undefined) {
      maximumUnexplainedGap = updateMaximum(
        maximumUnexplainedGap,
        round(Math.max(0, gap - previousDuration)),
      );
    }
  }
  const handled = new Set([
    ...events.decodedPackets.map(({ sequence }) => sequence),
    ...events.decodeFailedSequences,
  ]);
  const arrivalBySequence = new Map(
    packets.map((packet) => [packet.sequence, packet.atMs]),
  );
  let maximumReceiveToDecodeMs: number | null = null;
  for (const decoded of events.decodedPackets) {
    const receivedAt = arrivalBySequence.get(decoded.sequence);
    if (receivedAt !== undefined) {
      maximumReceiveToDecodeMs = updateMaximum(
        maximumReceiveToDecodeMs,
        round(Math.max(0, decoded.atMs - receivedAt)),
      );
    }
  }
  return {
    decoded_packet_count: events.decodedPackets.length,
    decode_failed_packet_count: events.decodeFailedSequences.size,
    unprocessed_packet_count: packets.filter(({ sequence }) => !handled.has(sequence)).length,
    maximum_receive_to_decode_ms: maximumReceiveToDecodeMs,
    maximum_packet_arrival_gap_ms: maximumGap,
    maximum_unexplained_arrival_gap_ms: maximumUnexplainedGap,
    receive_stream_close_count: events.receiveStreamCloseCount,
    receive_stream_recovery_count: events.receiveStreamRecoveryCount,
    maximum_receive_recovery_ms: events.maximumReceiveRecoveryMs,
    soniox_audio_chunk_count: events.sonioxAudioChunks.length,
    trailing_silence_chunk_count: events.sonioxAudioChunks.filter(
      ({ audioKind }) => audioKind === "trailing_silence",
    ).length,
  };
}

async function analyzeTokens(
  filePath: string,
): Promise<PrivateSttCaptureAnalysis["speakers"][number]["tokens"]> {
  const counts = {
    result_count: 0,
    original_token_count: 0,
    translation_token_count: 0,
    other_token_count: 0,
  };
  for await (const result of readJsonLines(filePath)) {
    stringField(result, "turn_id");
    numberField(result, "at_ms");
    for (const [field, countField] of [
      ["original_tokens", "original_token_count"],
      ["translation_tokens", "translation_token_count"],
      ["other_tokens", "other_token_count"],
    ] as const) {
      const tokens = result[field];
      if (!Array.isArray(tokens)) {
        throw new Error(`STT resultの${field}はarrayである必要があります`);
      }
      for (const token of tokens) {
        const tokenRecord = asRecord(token, `STT resultの${field}`);
        stringField(tokenRecord, "text");
      }
      counts[countField] += tokens.length;
    }
    counts.result_count += 1;
  }
  return counts;
}

async function analyzeSpeaker(
  directoryPath: string,
  speaker: string,
): Promise<PrivateSttCaptureAnalysis["speakers"][number]> {
  const opusPath = path.join(directoryPath, `${speaker}-opus.bin`);
  const stereoPath = path.join(directoryPath, `${speaker}-stereo.pcm`);
  const decodedMonoPath = path.join(directoryPath, `${speaker}-decoded-mono.pcm`);
  const sonioxInputPath = path.join(directoryPath, `${speaker}-soniox-input.pcm`);
  const eventsPath = path.join(directoryPath, `${speaker}-events.jsonl`);
  const resultsPath = path.join(directoryPath, `${speaker}-results.jsonl`);
  const [opus, pcm, events, tokens] = await Promise.all([
    hashFile(opusPath),
    analyzePcm(stereoPath, decodedMonoPath, sonioxInputPath),
    analyzeEvents(eventsPath),
    analyzeTokens(resultsPath),
  ]);
  validatePacketOffsets(
    events,
    opus.byteLength,
    pcm.stereo.byte_length,
    pcm.decodedMono.byte_length,
  );
  validateSonioxAudioOffsets(events, pcm.sonioxMono.byte_length);
  return {
    speaker,
    opus: {
      byte_length: opus.byteLength,
      packet_count: events.opusPackets.length,
      sha256: opus.sha256,
    },
    stereo_pcm: pcm.stereo,
    decoded_mono_pcm: pcm.decodedMono,
    soniox_mono_pcm: pcm.sonioxMono,
    channel_comparison: pcm.channelComparison,
    transport: transportMetrics(events),
    segmentation: {
      speaking_segment_count: events.speakingSegmentCount,
      speaking_end_count: events.speakingEndCount,
      manual_finalize_request_count: events.manualFinalizeRequestCount,
      manual_finalize_requests_by_reason: events.manualFinalizeRequestsByReason,
      stt_endpoint_count: events.sttEndpointCount,
      stt_finalized_count: events.sttFinalizedCount,
      stt_endpoint_after_speaking_end_ms: durationSummary(
        events.sttEndpointAfterSpeakingEndMs,
      ),
      stt_endpoint_without_prior_speaking_end_count:
        events.sttEndpointWithoutPriorSpeakingEndCount,
      maximum_speaking_start_to_first_packet_ms:
        events.maximumSpeakingStartToFirstPacketMs,
      maximum_last_packet_to_speaking_end_ms:
        events.maximumLastPacketToSpeakingEndMs,
    },
    tokens,
  };
}

export async function analyzePrivateSttCapture(
  directoryPath: string,
): Promise<PrivateSttCaptureAnalysis> {
  const resolvedPath = await validatePrivateSttCaptureDirectory(directoryPath);
  const metadata = await readSessionMetadata(resolvedPath);
  const entries = await readdir(resolvedPath);
  const speakers = entries.flatMap((entry) => {
    const match = /^(speaker-\d{2})-events\.jsonl$/u.exec(entry);
    return match?.[1] === undefined ? [] : [match[1]];
  }).sort();
  if (speakers.length === 0) {
    throw new Error("private STT captureに話者音声がありません");
  }
  return {
    version: 1,
    pair: metadata.pair,
    sample_rate: metadata.sampleRate,
    speakers: await Promise.all(
      speakers.map(async (speaker) => await analyzeSpeaker(resolvedPath, speaker)),
    ),
  };
}
