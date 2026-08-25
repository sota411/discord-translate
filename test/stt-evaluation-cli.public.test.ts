import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "discord-stt-eval-test-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
let datasetSequence = 0;

function writeDataset(traceByteLength = 8): {
  manifestPath: string;
  observationsPath: string;
  outputPath: string;
} {
  const audioDirectory = path.join(
    temporaryDirectory,
    `audio-${String(traceByteLength)}-${String(datasetSequence)}`,
  );
  datasetSequence += 1;
  mkdirSync(audioDirectory, { recursive: true });
  const audioPath = path.join(audioDirectory, "sample.pcm");
  const tracePath = path.join(audioDirectory, "sample.packets.json");
  const audio = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const packetTrace = JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: traceByteLength }],
  });
  writeFileSync(audioPath, audio);
  writeFileSync(tracePath, packetTrace);
  const manifestPath = path.join(audioDirectory, "manifest.json");
  const manifest = JSON.stringify({
    version: 1,
    pair: "ja-ko",
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [{
      id: "private-reference",
      audio: "sample.pcm",
      packet_trace: "sample.packets.json",
      reference: "秘密の正解文",
      language: "ja",
      tags: ["clean"],
      key_terms: ["秘密"],
      expected_languages: ["ja"],
      expected_segments: 1,
      translation_terms: [{ source: "秘密", target: "비밀" }],
    }],
  });
  writeFileSync(manifestPath, manifest);
  const observationsPath = path.join(audioDirectory, "observations.json");
  writeFileSync(observationsPath, JSON.stringify({
    version: 1,
    dataset: {
      manifest_sha256: createHash("sha256").update(manifest).digest("hex"),
      cases: [{
        case_id: "private-reference",
        audio_sha256: createHash("sha256").update(audio).digest("hex"),
        packet_trace_sha256: createHash("sha256").update(packetTrace).digest("hex"),
        audio_bytes: 8,
        packet_count: 1,
        dropped_packet_count: 0,
        duration_ms: 8 / (48_000 * 2) * 1_000,
      }],
    },
    results: [{
      case_id: "private-reference",
      profile: "baseline",
      transcript: "秘密の認識文",
      segments: ["秘密の認識文"],
      recognized_languages: ["ja"],
      finalization_latencies_ms: [320],
      cpu_percent: 5,
      decoded_packet_count: 1,
      dropped_packet_count: 0,
    }],
  }));
  return {
    manifestPath,
    observationsPath,
    outputPath: path.join(audioDirectory, "report.json"),
  };
}

function runScore(paths: ReturnType<typeof writeDataset>) {
  return spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/evaluate-stt.ts",
    "score",
    "--manifest",
    paths.manifestPath,
    "--observations",
    paths.observationsPath,
    "--output",
    paths.outputPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

void test("評価CLIはPCMとpacket traceを検証し、本文や音声を含まない指標JSONを生成する", () => {
  const paths = writeDataset();
  const result = runScore(paths);

  assert.equal(result.status, 0, result.stderr);
  const reportText = readFileSync(paths.outputPath, "utf8");
  const report = JSON.parse(reportText) as {
    profiles: { baseline: { cer: number } };
    dataset: { cases: { audio_sha256: string; packet_trace_sha256: string }[] };
  };
  assert.ok(report.profiles.baseline.cer > 0);
  assert.match(report.dataset.cases[0]?.audio_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(report.dataset.cases[0]?.packet_trace_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(reportText, /秘密|認識文|AAECAw|SONIOX_API_KEY/u);
});

void test("packet traceのbyte合計がPCMと違う場合は接続や出力より前に拒否する", () => {
  const paths = writeDataset(6);
  const result = runScore(paths);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /byte.*PCM/u);
  assert.throws(() => readFileSync(paths.outputPath, "utf8"), /ENOENT/u);
});

void test("観測時と採点時のPCMが違う場合はSHA-256証拠で拒否する", () => {
  const paths = writeDataset();
  const observations = JSON.parse(readFileSync(paths.observationsPath, "utf8")) as {
    dataset: { cases: { audio_sha256: string }[] };
  };
  const firstCase = observations.dataset.cases[0];
  assert.ok(firstCase);
  firstCase.audio_sha256 = "0".repeat(64);
  writeFileSync(paths.observationsPath, JSON.stringify(observations));

  const result = runScore(paths);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dataset.*一致しません/u);
  assert.throws(() => readFileSync(paths.outputPath, "utf8"), /ENOENT/u);
});
