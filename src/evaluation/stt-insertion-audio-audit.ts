import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { LoadedSttEvaluationDataset } from "./stt-evaluation-files.js";
import {
  createPcmS16leMonoWav,
  sha256,
  SttInsertionDiscordOpusRoundTrip,
  sttInsertionPcmBytesPerSample,
  sttInsertionPcmSampleRate,
} from "./stt-insertion-audio.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const audioFileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]*\.wav$/u);
const auditCaseSchema = z.object({
  case_id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u),
  intended_reference: z.string().refine((value) => value.trim().length > 0),
  heard_reference: z.string().refine((value) => value.trim().length > 0).nullable(),
  reference_status: z.enum(["pending", "verified", "ambiguous", "invalid"]),
  audit_note: z.string(),
  source_audio_sha256: sha256Schema,
  source_duration_ms: z.number().positive(),
  source_wav: audioFileNameSchema,
  source_wav_sha256: sha256Schema,
  opus_roundtrip_audio_sha256: sha256Schema,
  opus_roundtrip_duration_ms: z.number().positive(),
  opus_roundtrip_wav: audioFileNameSchema,
  opus_roundtrip_wav_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.reference_status === "verified" && value.heard_reference === null) {
    context.addIssue({
      code: "custom",
      path: ["heard_reference"],
      message: "verifiedにはheard_referenceが必要です",
    });
  }
  if (value.reference_status === "pending" && value.heard_reference !== null) {
    context.addIssue({
      code: "custom",
      path: ["heard_reference"],
      message: "pendingのheard_referenceはnullにしてください",
    });
  }
  if (
    (value.reference_status === "ambiguous" || value.reference_status === "invalid") &&
    value.audit_note.trim().length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["audit_note"],
      message: `${value.reference_status}には理由が必要です`,
    });
  }
});

const audioAuditSchema = z.object({
  version: z.literal(1),
  experiment: z.literal("insertion_audio_audit"),
  manifest_sha256: sha256Schema,
  audio_format: z.object({
    format: z.literal("wav_pcm_s16le"),
    sample_rate: z.literal(48_000),
    channels: z.literal(1),
  }).strict(),
  cases: z.array(auditCaseSchema).min(1),
}).strict().superRefine((value, context) => {
  const caseIds = new Set<string>();
  const fileNames = new Set<string>();
  for (const [index, auditCase] of value.cases.entries()) {
    if (caseIds.has(auditCase.case_id)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "case_id"],
        message: "case_idを重複させないでください",
      });
    }
    caseIds.add(auditCase.case_id);
    for (const fileName of [auditCase.source_wav, auditCase.opus_roundtrip_wav]) {
      if (fileNames.has(fileName)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index],
          message: "監査WAVのfile名を重複させないでください",
        });
      }
      fileNames.add(fileName);
    }
  }
});

export type SttInsertionAudioAudit = z.infer<typeof audioAuditSchema>;
export type SttInsertionAudioAuditFile = {
  kind: "source" | "opus_roundtrip";
  case_id: string;
  file_name: string;
  bytes: Buffer;
};

export type VerifiedSttInsertionAudioAudit = {
  audit_sha256: string;
  manifest_sha256: string;
  cases: {
    case_id: string;
    intended_reference: string;
    heard_reference: string;
    audit_note: string;
    source_audio_sha256: string;
    source_wav_sha256: string;
    opus_roundtrip_audio_sha256: string;
    opus_roundtrip_wav_sha256: string;
  }[];
};

function parseAuditValue(value: unknown): SttInsertionAudioAudit {
  const parsed = audioAuditSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`STT音声監査が不正です: ${issues}`);
}

export function parseSttInsertionAudioAudit(json: string): SttInsertionAudioAudit {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error("STT音声監査が有効なJSONではありません", { cause: error });
  }
  return parseAuditValue(value);
}

function selectCases(dataset: LoadedSttEvaluationDataset, caseIds: readonly string[]) {
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) {
    throw new Error("STT音声監査のcase IDは重複なしで1件以上指定してください");
  }
  const casesById = new Map(dataset.cases.map((evaluationCase) => [
    evaluationCase.definition.id,
    evaluationCase,
  ]));
  return caseIds.map((caseId) => {
    const evaluationCase = casesById.get(caseId);
    if (!evaluationCase) throw new Error(`STT音声監査のcase「${caseId}」がありません`);
    return evaluationCase;
  });
}

export function createPendingSttInsertionAudioAudit(
  dataset: LoadedSttEvaluationDataset,
  caseIds: readonly string[],
): { audit: SttInsertionAudioAudit; audio_files: SttInsertionAudioAuditFile[] } {
  const selectedCases = selectCases(dataset, caseIds);
  const audioFiles: SttInsertionAudioAuditFile[] = [];
  const auditCases = selectedCases.map((evaluationCase) => {
    const sourcePcm = Buffer.concat(evaluationCase.packets.map((packet) => packet.audio));
    const opusRoundTrip = new SttInsertionDiscordOpusRoundTrip();
    const opusPcm = Buffer.concat(evaluationCase.packets.map(
      (packet) => opusRoundTrip.process(packet.audio).audio,
    ));
    const sourceWav = createPcmS16leMonoWav(sourcePcm);
    const opusWav = createPcmS16leMonoWav(opusPcm);
    const sourceFileName = `${evaluationCase.definition.id}.source.wav`;
    const opusFileName = `${evaluationCase.definition.id}.opus-roundtrip.wav`;
    audioFiles.push({
      kind: "source",
      case_id: evaluationCase.definition.id,
      file_name: sourceFileName,
      bytes: sourceWav,
    }, {
      kind: "opus_roundtrip",
      case_id: evaluationCase.definition.id,
      file_name: opusFileName,
      bytes: opusWav,
    });
    return {
      case_id: evaluationCase.definition.id,
      intended_reference: evaluationCase.definition.reference,
      heard_reference: null,
      reference_status: "pending" as const,
      audit_note: "",
      source_audio_sha256: sha256(sourcePcm),
      source_duration_ms: sourcePcm.length /
        (sttInsertionPcmSampleRate * sttInsertionPcmBytesPerSample) * 1_000,
      source_wav: sourceFileName,
      source_wav_sha256: sha256(sourceWav),
      opus_roundtrip_audio_sha256: sha256(opusPcm),
      opus_roundtrip_duration_ms: opusPcm.length /
        (sttInsertionPcmSampleRate * sttInsertionPcmBytesPerSample) * 1_000,
      opus_roundtrip_wav: opusFileName,
      opus_roundtrip_wav_sha256: sha256(opusWav),
    };
  });
  return {
    audit: parseAuditValue({
      version: 1,
      experiment: "insertion_audio_audit",
      manifest_sha256: dataset.manifestSha256,
      audio_format: {
        format: "wav_pcm_s16le",
        sample_rate: 48_000,
        channels: 1,
      },
      cases: auditCases,
    }),
    audio_files: audioFiles,
  };
}

async function assertOwnerOnlyRegularFile(filePath: string, label: string): Promise<void> {
  const status = await lstat(filePath);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new Error(`${label}「${filePath}」は通常fileかつ0600にしてください`);
  }
}

export async function loadVerifiedSttInsertionAudioAudit(
  dataset: LoadedSttEvaluationDataset,
  auditFilePath: string,
  caseIds: readonly string[],
): Promise<VerifiedSttInsertionAudioAudit> {
  const selectedCases = selectCases(dataset, caseIds);
  const auditPath = path.resolve(auditFilePath);
  await assertOwnerOnlyRegularFile(auditPath, "STT音声監査JSON");
  const auditBytes = await readFile(auditPath);
  const audit = parseSttInsertionAudioAudit(auditBytes.toString("utf8"));
  if (audit.manifest_sha256 !== dataset.manifestSha256) {
    throw new Error("STT音声監査のmanifest SHA-256がdatasetと一致しません");
  }
  const expectedBundle = createPendingSttInsertionAudioAudit(dataset, caseIds);
  const expectedCases = new Map(expectedBundle.audit.cases.map((entry) => [entry.case_id, entry]));
  const expectedFiles = new Map(expectedBundle.audio_files.map((entry) => [entry.file_name, entry]));
  const auditedCases = new Map(audit.cases.map((entry) => [entry.case_id, entry]));
  const verifiedCases: VerifiedSttInsertionAudioAudit["cases"] = [];
  for (const evaluationCase of selectedCases) {
    const caseId = evaluationCase.definition.id;
    const actual = auditedCases.get(caseId);
    const expected = expectedCases.get(caseId);
    if (!actual || !expected) throw new Error(`STT音声監査にcase「${caseId}」がありません`);
    if (actual.reference_status !== "verified" || actual.heard_reference === null) {
      throw new Error(`case「${caseId}」の音声監査はverifiedではありません`);
    }
    const evidenceFields = [
      "intended_reference",
      "source_audio_sha256",
      "source_duration_ms",
      "source_wav",
      "source_wav_sha256",
      "opus_roundtrip_audio_sha256",
      "opus_roundtrip_duration_ms",
      "opus_roundtrip_wav",
      "opus_roundtrip_wav_sha256",
    ] as const;
    for (const field of evidenceFields) {
      if (actual[field] !== expected[field]) {
        throw new Error(`case「${caseId}」の音声監査${field}がdatasetと一致しません`);
      }
    }
    for (const fileName of [actual.source_wav, actual.opus_roundtrip_wav]) {
      const expectedFile = expectedFiles.get(fileName);
      if (!expectedFile) throw new Error(`case「${caseId}」の監査WAVを解決できません`);
      const filePath = path.join(path.dirname(auditPath), fileName);
      await assertOwnerOnlyRegularFile(filePath, `case「${caseId}」の監査WAV`);
      const actualBytes = await readFile(filePath);
      if (!actualBytes.equals(expectedFile.bytes)) {
        throw new Error(`case「${caseId}」の監査WAVがdatasetから生成した音声と一致しません`);
      }
    }
    verifiedCases.push({
      case_id: caseId,
      intended_reference: actual.intended_reference,
      heard_reference: actual.heard_reference,
      audit_note: actual.audit_note,
      source_audio_sha256: actual.source_audio_sha256,
      source_wav_sha256: actual.source_wav_sha256,
      opus_roundtrip_audio_sha256: actual.opus_roundtrip_audio_sha256,
      opus_roundtrip_wav_sha256: actual.opus_roundtrip_wav_sha256,
    });
  }
  return {
    audit_sha256: sha256(auditBytes),
    manifest_sha256: audit.manifest_sha256,
    cases: verifiedCases,
  };
}
