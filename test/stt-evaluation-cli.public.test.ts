import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import { runSttEvaluationCli } from "../src/evaluate-stt.js";
import { createSttEvaluationDatasetEvidence } from "../src/evaluation/stt-evaluation-files.js";
import { sttEvaluationProfileConfigurations } from "../src/evaluation/stt-evaluation.js";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "discord-stt-eval-test-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
let datasetSequence = 0;

void test("評価CLIはprovider比較、音声監査、大量挿入triageのコマンドを案内する", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/evaluate-stt.ts",
    "--help",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compare-provider/u);
  assert.match(result.stdout, /aws-region/u);
  assert.match(result.stdout, /triage-insertions/u);
  assert.match(result.stdout, /prepare-insertion-audit/u);
  assert.match(result.stdout, /--audio-audit/u);
  assert.match(result.stdout, /--cases/u);
});

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
  mkdirSync(audioDirectory, { recursive: true, mode: 0o700 });
  chmodSync(audioDirectory, 0o700);
  const audioPath = path.join(audioDirectory, "sample.pcm");
  const tracePath = path.join(audioDirectory, "sample.packets.json");
  const audio = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const packetTrace = JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: traceByteLength }],
  });
  writeFileSync(audioPath, audio, { mode: 0o600 });
  writeFileSync(tracePath, packetTrace, { mode: 0o600 });
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
  writeFileSync(manifestPath, manifest, { mode: 0o600 });
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
      finalizations: [
        { kind: "finalized", reason: "speaking_end", latency_ms: 320, has_text: true },
      ],
      cpu_percent: 5,
      decoded_packet_count: 1,
      dropped_packet_count: 0,
      configuration: sttEvaluationProfileConfigurations.baseline,
    }],
  }), { mode: 0o600 });
  return {
    manifestPath,
    observationsPath,
    outputPath: path.join(audioDirectory, "report.json"),
  };
}

void test("音声監査CLIはprivate WAVとpending監査JSONを新規作成する", async () => {
  const paths = writeDataset();
  const outputDirectory = path.join(temporaryDirectory, `audio-audit-${String(datasetSequence)}`);

  const summary = await runSttEvaluationCli([
    "prepare-insertion-audit",
    "--manifest",
    paths.manifestPath,
    "--cases",
    "private-reference",
    "--output-directory",
    outputDirectory,
  ]);

  assert.deepEqual(summary, {
    experiment: "insertion_audio_audit",
    case_count: 1,
    audio_file_count: 2,
    audit_status: "pending_human_review",
    live_triage_allowed: false,
  });
  const auditPath = path.join(outputDirectory, "audit.json");
  const sourceWavPath = path.join(outputDirectory, "private-reference.source.wav");
  const opusWavPath = path.join(outputDirectory, "private-reference.opus-roundtrip.wav");
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    cases: { reference_status: string; heard_reference: string | null }[];
  };
  const firstAuditCase = audit.cases[0];
  assert.ok(firstAuditCase);
  assert.equal(firstAuditCase.reference_status, "pending");
  assert.equal(firstAuditCase.heard_reference, null);
  for (const filePath of [auditPath, sourceWavPath, opusWavPath]) {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  }
  assert.equal(statSync(outputDirectory).mode & 0o777, 0o700);
  assert.equal(readFileSync(sourceWavPath).subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(readFileSync(opusWavPath).subarray(8, 12).toString("ascii"), "WAVE");

  await assert.rejects(
    runSttEvaluationCli([
      "prepare-insertion-audit",
      "--manifest",
      paths.manifestPath,
      "--cases",
      "private-reference",
      "--output-directory",
      outputDirectory,
    ]),
    /既に存在/u,
  );
});

void test("pending音声監査ではlive triageへ接続する前に拒否する", async () => {
  const paths = writeDataset();
  const outputDirectory = path.join(temporaryDirectory, `pending-audit-${String(datasetSequence)}`);
  await runSttEvaluationCli([
    "prepare-insertion-audit",
    "--manifest",
    paths.manifestPath,
    "--cases",
    "private-reference",
    "--output-directory",
    outputDirectory,
  ]);

  await assert.rejects(
    runSttEvaluationCli([
      "triage-insertions",
      "--manifest",
      paths.manifestPath,
      "--audio-audit",
      path.join(outputDirectory, "audit.json"),
      "--cases",
      "private-reference",
      "--observations-output",
      path.join(outputDirectory, "observations.json"),
      "--output",
      path.join(outputDirectory, "report.json"),
      "--stt-websocket-url",
      "ws://127.0.0.1:9",
      "--trials",
      "1",
    ], {
      environment: {
        SONIOX_API_KEY: "do-not-leak-api-key",
        SONIOX_STT_MODEL: "stt-rt-v5",
      },
    }),
    /verified/u,
  );
});

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
  assert.doesNotMatch(result.stdout, new RegExp(temporaryDirectory, "u"));
  assert.equal((JSON.parse(result.stdout) as { report_written: boolean }).report_written, true);
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

void test("repo外のprivate入力も0600でなければ採点前に拒否する", () => {
  const paths = writeDataset();
  chmodSync(paths.manifestPath, 0o644);

  const result = runScore(paths);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0600/u);
  assert.throws(() => readFileSync(paths.outputPath, "utf8"), /ENOENT/u);
});

void test("compare-provider CLIはprivate観測と本文非含有reportを0600で保存する", async () => {
  const paths = writeDataset();
  const observationsOutput = path.join(path.dirname(paths.outputPath), "provider-observations.json");
  const reportOutput = path.join(path.dirname(paths.outputPath), "provider-report.json");
  const summary = await runSttEvaluationCli([
    "compare-provider",
    "--manifest",
    paths.manifestPath,
    "--observations-output",
    observationsOutput,
    "--output",
    reportOutput,
    "--aws-region",
    "us-west-2",
    "--stt-websocket-url",
    "ws://127.0.0.1:9",
    "--trials",
    "1",
  ], {
    environment: {
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    },
    async runProviderComparisonDataset(dataset, options) {
      await Promise.resolve();
      assert.equal(options.apiKey, "do-not-leak-api-key");
      assert.equal(options.amazonRegion, "us-west-2");
      assert.equal(options.trials, 1);
      const commonResult = {
        trial: 1,
        case_id: "private-reference",
        transcript: "秘密の正解文",
        segments: ["秘密の正解文"],
        recognized_languages: ["ja" as const],
        cpu_percent: 1,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
      };
      return {
        version: 1,
        experiment: "provider_comparison",
        provider_environment: {
          amazon_transcribe: { region: options.amazonRegion },
        },
        dataset: createSttEvaluationDatasetEvidence(dataset),
        results: [
          {
            ...commonResult,
            profile: "baseline",
            finalizations: [{
              kind: "finalized",
              reason: "speaking_end",
              latency_ms: 200,
              has_text: true,
            }],
            configuration: sttEvaluationProfileConfigurations.baseline,
          },
          {
            ...commonResult,
            profile: "amazon_transcribe",
            finalizations: [{
              kind: "finalized",
              reason: "provider_final",
              latency_ms: 300,
              has_text: true,
            }],
            configuration: sttEvaluationProfileConfigurations.amazon_transcribe,
          },
        ],
      };
    },
  });

  assert.deepEqual(summary, {
    observations_written: true,
    report_written: true,
    experiment: "provider_comparison",
    profiles: ["baseline", "amazon_transcribe"],
    provider_region: "us-west-2",
    case_count: 1,
    trial_count: 1,
  });
  const observationsText = readFileSync(observationsOutput, "utf8");
  const reportText = readFileSync(reportOutput, "utf8");
  assert.match(observationsText, /秘密の正解文/u);
  assert.doesNotMatch(reportText, /秘密|do-not-leak-api-key/u);
  assert.equal(statSync(observationsOutput).mode & 0o777, 0o600);
  assert.equal(statSync(reportOutput).mode & 0o777, 0o600);
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

void test("observationsのPCM品質値が元音声からの再計算と違う場合は拒否する", () => {
  const paths = writeDataset();
  const observations = JSON.parse(readFileSync(paths.observationsPath, "utf8")) as {
    results: Record<string, unknown>[];
  };
  const result = observations.results[0];
  assert.ok(result);
  result.audio_metrics = {
    rms_dbfs: -20,
    peak_dbfs: -1,
    clipped_sample_ratio: 0,
    near_silence_ratio: 0,
    original_token_count: 0,
    original_confidence_mean: null,
    original_confidence_min: null,
  };
  writeFileSync(paths.observationsPath, JSON.stringify(observations));

  const scored = runScore(paths);

  assert.notEqual(scored.status, 0);
  assert.match(scored.stderr, /PCM品質.*一致しません/u);
  assert.throws(() => readFileSync(paths.outputPath, "utf8"), /ENOENT/u);
});

void test("評価出力のsymlinkからmanifestを上書きしない", () => {
  const paths = writeDataset();
  const manifestBefore = readFileSync(paths.manifestPath, "utf8");
  symlinkSync(paths.manifestPath, paths.outputPath);

  const result = runScore(paths);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link/u);
  assert.equal(readFileSync(paths.manifestPath, "utf8"), manifestBefore);
});
