import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  createPendingSttInsertionAudioAudit,
  loadVerifiedSttInsertionAudioAudit,
} from "../src/evaluation/stt-insertion-audio-audit.js";
import { loadSttEvaluationDataset } from "../src/evaluation/stt-evaluation-files.js";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "stt-insertion-audit-test-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

async function prepareAuditFixture() {
  const directory = path.join(temporaryDirectory, "dataset");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const pcm = Buffer.alloc(1_920);
  pcm.writeInt16LE(2_000, 0);
  writeFileSync(path.join(directory, "problem.pcm"), pcm, { mode: 0o600 });
  writeFileSync(path.join(directory, "problem.packets.json"), JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: pcm.length }],
  }), { mode: 0o600 });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    pair: "ja-ko",
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [{
      id: "problem-case",
      audio: "problem.pcm",
      packet_trace: "problem.packets.json",
      reference: "TTSへ入力した文",
      language: "ja",
      tags: ["clean"],
      key_terms: [],
      expected_languages: ["ja"],
      expected_segments: 1,
      translation_terms: [{ source: "用語", target: "용어" }],
    }],
  }), { mode: 0o600 });
  const dataset = await loadSttEvaluationDataset(manifestPath);
  const bundle = createPendingSttInsertionAudioAudit(dataset, ["problem-case"]);
  const auditDirectory = path.join(temporaryDirectory, "audit");
  mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
  chmodSync(auditDirectory, 0o700);
  for (const file of bundle.audio_files) {
    writeFileSync(path.join(auditDirectory, file.file_name), file.bytes, { mode: 0o600 });
  }
  const auditPath = path.join(auditDirectory, "audit.json");
  writeFileSync(auditPath, `${JSON.stringify(bundle.audit, null, 2)}\n`, { mode: 0o600 });
  return { dataset, bundle, auditPath, auditDirectory };
}

void test("音声監査bundleは元PCMとOpus往復PCMを48kHz mono WAVで出力する", async () => {
  const { bundle } = await prepareAuditFixture();

  assert.equal(bundle.audit.cases.length, 1);
  const firstAuditCase = bundle.audit.cases[0];
  assert.ok(firstAuditCase);
  assert.equal(firstAuditCase.reference_status, "pending");
  assert.equal(firstAuditCase.heard_reference, null);
  assert.equal(bundle.audio_files.length, 2);
  for (const file of bundle.audio_files) {
    assert.equal(file.bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(file.bytes.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(file.bytes.readUInt16LE(22), 1);
    assert.equal(file.bytes.readUInt32LE(24), 48_000);
    assert.equal(file.bytes.readUInt16LE(34), 16);
    assert.equal(file.bytes.readUInt32LE(40), file.bytes.length - 44);
  }
});

void test("未監査または曖昧な音声ではlive triageを開始できない", async () => {
  const { dataset, auditPath } = await prepareAuditFixture();

  await assert.rejects(
    loadVerifiedSttInsertionAudioAudit(dataset, auditPath, ["problem-case"]),
    /verified/u,
  );

  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    cases: { reference_status: string; heard_reference: string | null; audit_note: string }[];
  };
  const first = audit.cases[0];
  assert.ok(first);
  first.reference_status = "ambiguous";
  first.heard_reference = "複数に聞こえる文";
  first.audit_note = "末尾が不明瞭";
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    loadVerifiedSttInsertionAudioAudit(dataset, auditPath, ["problem-case"]),
    /verified/u,
  );
});

void test("verified監査は音声artifactとdatasetの一致を検証して読み込む", async () => {
  const { dataset, auditPath, auditDirectory, bundle } = await prepareAuditFixture();
  const audit = structuredClone(bundle.audit);
  const first = audit.cases[0];
  assert.ok(first);
  first.reference_status = "verified";
  first.heard_reference = "実際に聞こえた文";
  first.audit_note = "元音声とOpus往復音声を確認済み";
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });

  const verified = await loadVerifiedSttInsertionAudioAudit(
    dataset,
    auditPath,
    ["problem-case"],
  );

  assert.equal(verified.cases[0]?.heard_reference, "実際に聞こえた文");
  assert.match(verified.audit_sha256, /^[a-f0-9]{64}$/u);
  for (const file of bundle.audio_files) {
    assert.equal(statSync(path.join(auditDirectory, file.file_name)).mode & 0o777, 0o600);
  }

  const sourceFile = bundle.audio_files.find((file) => file.kind === "source");
  assert.ok(sourceFile);
  const tampered = Buffer.from(sourceFile.bytes);
  const lastByte = tampered.at(-1);
  assert.notEqual(lastByte, undefined);
  tampered[tampered.length - 1] = (lastByte ?? 0) ^ 1;
  writeFileSync(path.join(auditDirectory, sourceFile.file_name), tampered, { mode: 0o600 });
  await assert.rejects(
    loadVerifiedSttInsertionAudioAudit(dataset, auditPath, ["problem-case"]),
    /WAV.*一致しません/u,
  );
});
