import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  SttAudioMetricsAccumulator,
  type SttAudioMetricsLogFields,
} from "../observability/stt-audio-metrics.js";
import {
  parseSttEvaluationManifest,
  type SttEvaluationManifest,
  type SttEvaluationObservations,
} from "./stt-evaluation.js";

const packetTraceSchema = z.object({
  version: z.literal(1),
  dropped_packet_count: z.number().int().nonnegative().default(0),
  packets: z.array(z.object({
    at_ms: z.number().int().nonnegative(),
    byte_length: z.number().int().positive().refine((value) => value % 2 === 0, {
      message: "pcm_s16le packetのbyte_lengthは2の倍数にしてください",
    }),
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  let previousAt = -1;
  for (const [index, packet] of value.packets.entries()) {
    if (packet.at_ms <= previousAt) {
      context.addIssue({
        code: "custom",
        path: ["packets", index, "at_ms"],
        message: "packetのat_msは厳密な昇順にしてください",
      });
    }
    previousAt = packet.at_ms;
  }
});

export type SttEvaluationPacket = {
  atMs: number;
  audio: Buffer;
};

export type SttEvaluationPcmMetrics = Pick<
  SttAudioMetricsLogFields,
  "rms_dbfs" | "peak_dbfs" | "clipped_sample_ratio" | "near_silence_ratio"
>;

export type LoadedSttEvaluationCase = {
  definition: SttEvaluationManifest["cases"][number];
  audioPath: string;
  packetTracePath: string;
  audioSha256: string;
  packetTraceSha256: string;
  packets: SttEvaluationPacket[];
  pcmMetrics: SttEvaluationPcmMetrics;
  droppedPacketCount: number;
  durationMs: number;
};

export type LoadedSttEvaluationDataset = {
  manifest: SttEvaluationManifest;
  manifestPath: string;
  manifestSha256: string;
  cases: LoadedSttEvaluationCase[];
};

export type SttEvaluationDatasetEvidence = {
  manifest_sha256: string;
  cases: {
    case_id: string;
    audio_sha256: string;
    packet_trace_sha256: string;
    audio_bytes: number;
    packet_count: number;
    dropped_packet_count: number;
    duration_ms: number;
  }[];
};

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function measurePcmMetrics(
  packets: readonly SttEvaluationPacket[],
): SttEvaluationPcmMetrics {
  const accumulator = new SttAudioMetricsAccumulator();
  for (const packet of packets) accumulator.recordDecodedPacket(packet.audio);
  const measured = accumulator.take({
    traceId: "stt-evaluation",
    finalizeReason: "speaking_end",
  });
  return {
    rms_dbfs: measured.rms_dbfs,
    peak_dbfs: measured.peak_dbfs,
    clipped_sample_ratio: measured.clipped_sample_ratio,
    near_silence_ratio: measured.near_silence_ratio,
  };
}

async function readRequiredFile(filePath: string, label: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (error) {
    throw new Error(`${label}「${filePath}」を読み込めません`, { cause: error });
  }
}

function parsePacketTrace(json: string, filePath: string): z.infer<typeof packetTraceSchema> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`packet trace「${filePath}」が有効なJSONではありません`, { cause: error });
  }
  const parsed = packetTraceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`packet trace「${filePath}」が不正です: ${issues}`);
}

export async function loadSttEvaluationDataset(
  manifestFilePath: string,
): Promise<LoadedSttEvaluationDataset> {
  const manifestPath = path.resolve(manifestFilePath);
  const manifestBytes = await readRequiredFile(manifestPath, "STT評価manifest");
  const manifest = parseSttEvaluationManifest(manifestBytes.toString("utf8"));
  const baseDirectory = path.dirname(manifestPath);
  const cases: LoadedSttEvaluationCase[] = [];
  for (const definition of manifest.cases) {
    const audioPath = path.resolve(baseDirectory, definition.audio);
    const packetTracePath = path.resolve(baseDirectory, definition.packet_trace);
    const [audio, packetTraceBytes] = await Promise.all([
      readRequiredFile(audioPath, `case「${definition.id}」のPCM`),
      readRequiredFile(packetTracePath, `case「${definition.id}」のpacket trace`),
    ]);
    if (audio.length === 0 || audio.length % 2 !== 0) {
      throw new Error(`case「${definition.id}」のPCM byte数は正の2の倍数にしてください`);
    }
    const packetTrace = parsePacketTrace(packetTraceBytes.toString("utf8"), packetTracePath);
    const tracedBytes = packetTrace.packets
      .reduce((sum, packet) => sum + packet.byte_length, 0);
    if (tracedBytes !== audio.length) {
      throw new Error(
        `case「${definition.id}」のpacket trace byte合計${String(tracedBytes)}がPCM byte数${String(audio.length)}と一致しません`,
      );
    }
    let offset = 0;
    const packets = packetTrace.packets.map((packet) => {
      const end = offset + packet.byte_length;
      const chunk = audio.subarray(offset, end);
      offset = end;
      return { atMs: packet.at_ms, audio: chunk };
    });
    const lastPacket = packetTrace.packets.at(-1);
    if (!lastPacket) throw new Error(`case「${definition.id}」のpacket traceが空です`);
    const lastPacketDurationMs = lastPacket.byte_length / (48_000 * 2) * 1_000;
    cases.push({
      definition,
      audioPath,
      packetTracePath,
      audioSha256: hash(audio),
      packetTraceSha256: hash(packetTraceBytes),
      packets,
      pcmMetrics: measurePcmMetrics(packets),
      droppedPacketCount: packetTrace.dropped_packet_count,
      durationMs: lastPacket.at_ms + lastPacketDurationMs,
    });
  }
  return { manifest, manifestPath, manifestSha256: hash(manifestBytes), cases };
}

export function createSttEvaluationDatasetEvidence(
  dataset: LoadedSttEvaluationDataset,
): SttEvaluationDatasetEvidence {
  return {
    manifest_sha256: dataset.manifestSha256,
    cases: dataset.cases.map((evaluationCase) => ({
      case_id: evaluationCase.definition.id,
      audio_sha256: evaluationCase.audioSha256,
      packet_trace_sha256: evaluationCase.packetTraceSha256,
      audio_bytes: evaluationCase.packets
        .reduce((sum, packet) => sum + packet.audio.length, 0),
      packet_count: evaluationCase.packets.length,
      dropped_packet_count: evaluationCase.droppedPacketCount,
      duration_ms: evaluationCase.durationMs,
    })),
  };
}

export function assertSttEvaluationDatasetEvidenceMatches(
  dataset: LoadedSttEvaluationDataset,
  observations: SttEvaluationObservations,
): void {
  if (!observations.dataset) {
    throw new Error("STT評価観測結果にdatasetのSHA-256証拠がありません");
  }
  const expected = createSttEvaluationDatasetEvidence(dataset);
  if (JSON.stringify(observations.dataset) !== JSON.stringify(expected)) {
    throw new Error("STT評価観測結果のdataset証拠が指定されたmanifest・PCM・packet traceと一致しません");
  }
  const evidenceByCase = new Map(expected.cases.map((entry) => [entry.case_id, entry]));
  const loadedCaseById = new Map(dataset.cases.map((entry) => [entry.definition.id, entry]));
  for (const result of observations.results) {
    const evidence = evidenceByCase.get(result.case_id);
    if (
      result.decoded_packet_count !== evidence?.packet_count ||
      result.dropped_packet_count !== evidence.dropped_packet_count
    ) {
      throw new Error(`case「${result.case_id}」のpacket観測数がdataset証拠と一致しません`);
    }
    if (result.audio_metrics) {
      const loadedCase = loadedCaseById.get(result.case_id);
      if (!loadedCase) throw new Error(`case「${result.case_id}」のPCM品質を検証できません`);
      const observedPcmMetrics: SttEvaluationPcmMetrics = {
        rms_dbfs: result.audio_metrics.rms_dbfs,
        peak_dbfs: result.audio_metrics.peak_dbfs,
        clipped_sample_ratio: result.audio_metrics.clipped_sample_ratio,
        near_silence_ratio: result.audio_metrics.near_silence_ratio,
      };
      if (JSON.stringify(observedPcmMetrics) !== JSON.stringify(loadedCase.pcmMetrics)) {
        throw new Error(`case「${result.case_id}」のPCM品質が元音声からの再計算と一致しません`);
      }
    }
  }
}
