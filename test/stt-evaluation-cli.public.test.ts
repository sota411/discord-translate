import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "discord-stt-eval-test-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function writeDataset(traceByteLength = 8): {
  manifestPath: string;
  observationsPath: string;
  outputPath: string;
} {
  const audioDirectory = path.join(temporaryDirectory, `audio-${String(traceByteLength)}`);
  mkdirSync(audioDirectory, { recursive: true });
  const audioPath = path.join(audioDirectory, "sample.pcm");
  const tracePath = path.join(audioDirectory, "sample.packets.json");
  writeFileSync(audioPath, Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]));
  writeFileSync(tracePath, JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: traceByteLength }],
  }));
  const manifestPath = path.join(audioDirectory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
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
  }));
  const observationsPath = path.join(audioDirectory, "observations.json");
  writeFileSync(observationsPath, JSON.stringify({
    version: 1,
    results: [{
      case_id: "private-reference",
      profile: "baseline",
      transcript: "秘密の認識文",
      segments: ["秘密の認識文"],
      recognized_languages: ["ja"],
      finalization_latencies_ms: [320],
      cpu_percent: 5,
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
