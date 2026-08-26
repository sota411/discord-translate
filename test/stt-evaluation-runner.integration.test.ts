import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import {
  createPendingSttInsertionAudioAudit,
  loadVerifiedSttInsertionAudioAudit,
} from "../src/evaluation/stt-insertion-audio-audit.js";
import {
  loadSttEvaluationDataset,
  type LoadedSttEvaluationDataset,
} from "../src/evaluation/stt-evaluation-files.js";
import { runSttInsertionTriageDataset } from "../src/evaluation/stt-insertion-triage-runner.js";
import { runSttEvaluationDataset } from "../src/evaluation/stt-evaluation-runner.js";
import {
  createSttEvaluationReport,
  parseSttEvaluationObservations,
} from "../src/evaluation/stt-evaluation.js";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "discord-stt-runner-test-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function withServer(
  onConnection: (socket: WebSocket) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`ws://127.0.0.1:${String(address.port)}`);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function writeDataset(
  directory = path.join(temporaryDirectory, "dataset"),
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path.join(directory, "sample.pcm"), Buffer.alloc(1_920), { mode: 0o600 });
  writeFileSync(path.join(directory, "sample.packets.json"), JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: 1_920 }],
  }), { mode: 0o600 });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    pair: "ja-ko",
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [{
      id: "ja-term",
      audio: "sample.pcm",
      packet_trace: "sample.packets.json",
      reference: "ヴァロラント",
      language: "ja",
      tags: ["clean", "game-term"],
      key_terms: ["ヴァロラント"],
      expected_languages: ["ja"],
      expected_segments: 1,
      translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
    }],
  }), { mode: 0o600 });
  return manifestPath;
}

function writeGapDataset(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path.join(directory, "sample.pcm"), Buffer.alloc(3_840), { mode: 0o600 });
  writeFileSync(path.join(directory, "sample.packets.json"), JSON.stringify({
    version: 1,
    packets: [
      { at_ms: 0, byte_length: 1_920 },
      { at_ms: 350, byte_length: 1_920 },
    ],
  }), { mode: 0o600 });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    pair: "ja-ko",
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [{
      id: "ja-term",
      audio: "sample.pcm",
      packet_trace: "sample.packets.json",
      reference: "ヴァロラントヴァロラント後半",
      language: "ja",
      tags: ["clean", "game-term"],
      key_terms: ["ヴァロラント"],
      expected_languages: ["ja"],
      expected_segments: 2,
      translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
    }],
  }), { mode: 0o600 });
  return manifestPath;
}

async function writeVerifiedAudioAudit(
  dataset: LoadedSttEvaluationDataset,
  directory: string,
  caseIds: readonly string[],
) {
  const bundle = createPendingSttInsertionAudioAudit(dataset, caseIds);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const file of bundle.audio_files) {
    writeFileSync(path.join(directory, file.file_name), file.bytes, { mode: 0o600 });
  }
  const mutableAudit = JSON.parse(JSON.stringify(bundle.audit)) as {
    cases: {
      case_id: string;
      reference_status: "pending" | "verified";
      heard_reference: string | null;
      audit_note: string;
    }[];
  };
  for (const auditCase of mutableAudit.cases) {
    auditCase.reference_status = "verified";
    auditCase.heard_reference = dataset.cases.find(
      (evaluationCase) => evaluationCase.definition.id === auditCase.case_id,
    )?.definition.reference ?? null;
    assert.notEqual(auditCase.heard_reference, null);
    auditCase.audit_note = "test fixtureで確認済み";
  }
  const auditPath = path.join(directory, "audit.json");
  writeFileSync(auditPath, `${JSON.stringify(mutableAudit, null, 2)}\n`, { mode: 0o600 });
  return {
    auditPath,
    verified: await loadVerifiedSttInsertionAudioAudit(dataset, auditPath, caseIds),
  };
}

function writePendingAudioAudit(
  dataset: LoadedSttEvaluationDataset,
  directory: string,
  caseIds: readonly string[],
): string {
  const bundle = createPendingSttInsertionAudioAudit(dataset, caseIds);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const file of bundle.audio_files) {
    writeFileSync(path.join(directory, file.file_name), file.bytes, { mode: 0o600 });
  }
  const auditPath = path.join(directory, "audit.json");
  writeFileSync(auditPath, `${JSON.stringify(bundle.audit, null, 2)}\n`, { mode: 0o600 });
  return auditPath;
}

function writeRecognitionCatalogDataset(
  directory = path.join(temporaryDirectory, "recognition-catalog-dataset"),
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path.join(directory, "sample.pcm"), Buffer.alloc(1_920), { mode: 0o600 });
  writeFileSync(path.join(directory, "sample.packets.json"), JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: 1_920 }],
  }), { mode: 0o600 });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    pair: "ja-ko",
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [
      {
        id: "ja-term",
        audio: "sample.pcm",
        packet_trace: "sample.packets.json",
        reference: "テスト固有語アルファ DemoVoice",
        language: "ja",
        tags: ["clean", "game-term"],
        key_terms: ["テスト固有語アルファ", "DemoVoice"],
        expected_languages: ["ja"],
        expected_segments: 1,
        translation_terms: [{ source: "テスト翻訳元", target: "테스트번역대상" }],
      },
      {
        id: "ko-term",
        audio: "sample.pcm",
        packet_trace: "sample.packets.json",
        reference: "테스트고유어베타 DemoVoice",
        language: "ko",
        tags: ["clean", "game-term"],
        key_terms: ["테스트고유어베타", "DemoVoice"],
        expected_languages: ["ko"],
        expected_segments: 1,
        translation_terms: [{ source: "테스트번역원문", target: "Test Translation Target" }],
      },
    ],
  }), { mode: 0o600 });
  return manifestPath;
}

function handleSuccessfulSttConnection(socket: WebSocket): void {
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      socket.send(JSON.stringify({
        tokens: [
          {
            text: "ヴァロラント",
            is_final: true,
            confidence: 0.95,
            language: "ja",
            translation_status: "original",
            start_ms: 0,
            end_ms: 20,
          },
          { text: "<end>", is_final: true },
        ],
        final_audio_proc_ms: 20,
        total_audio_proc_ms: 20,
      }));
      return;
    }
    if (rawDataToUtf8(data).length === 0) {
      socket.send(JSON.stringify({
        tokens: [],
        final_audio_proc_ms: 20,
        total_audio_proc_ms: 20,
        finished: true,
      }));
    }
  });
}

async function runEvaluationCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/evaluate-stt.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

void test("同じPCMを複数試行し、A〜Dの開始順を交替してcontextだけをprofileどおり変更する", async () => {
  const configurations: Record<string, unknown>[] = [];
  const audioByConnection: Buffer[][] = [];
  await withServer((socket) => {
    const audio: Buffer[] = [];
    audioByConnection.push(audio);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        audio.push(Buffer.from(data as Buffer));
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      profiles: ["baseline", "context", "endpoint", "context_endpoint"],
      trials: 2,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });

    assert.deepEqual(observations.results.map((result) => result.profile), [
      "baseline",
      "context",
      "endpoint",
      "context_endpoint",
      "context",
      "endpoint",
      "context_endpoint",
      "baseline",
    ]);
    assert.deepEqual(observations.results.map((result) => result.trial), [
      1, 1, 1, 1, 2, 2, 2, 2,
    ]);
    assert.ok(observations.results.every((result) => result.transcript === "ヴァロラント"));
    for (const result of observations.results) {
      assert.ok(result.audio_metrics);
      assert.equal(result.audio_metrics.rms_dbfs, null);
      assert.equal(result.audio_metrics.peak_dbfs, null);
      assert.equal(result.audio_metrics.clipped_sample_ratio, 0);
      assert.equal(result.audio_metrics.near_silence_ratio, 1);
      assert.equal(result.audio_metrics.original_token_count, 1);
      assert.equal(result.audio_metrics.original_confidence_mean, 0.95);
      assert.equal(result.audio_metrics.original_confidence_min, 0.95);
      assert.deepEqual(result.original_final_tokens, [{
        start_ms: 0,
        end_ms: 20,
        text: "ヴァロラント",
        language: "ja",
        confidence: 0.95,
      }]);
    }
    const reparsed = parseSttEvaluationObservations(JSON.stringify(observations));
    assert.deepEqual(
      reparsed.results[0]?.original_final_tokens,
      observations.results[0]?.original_final_tokens,
    );
    assert.deepEqual(
      observations.results.map((result) => result.configuration.manual_finalize_fallback_ms),
      [100, 100, 600, 600, 100, 600, 600, 100],
    );
    assert.deepEqual(
      observations.results.map((result) => result.configuration.soniox_max_endpoint_delay_ms),
      [2_000, 2_000, 500, 500, 2_000, 500, 500, 2_000],
    );
    for (const result of observations.results) {
      const firstFinalization = result.finalizations[0];
      assert.ok(firstFinalization);
      assert.equal(firstFinalization.kind, "endpoint");
      assert.equal(firstFinalization.reason, "soniox_endpoint");
      assert.equal(firstFinalization.has_text, true);
      assert.ok(firstFinalization.latency_ms >= 0);
    }
    assert.doesNotMatch(JSON.stringify(observations), /do-not-leak-api-key/u);
  });

  assert.equal(configurations.length, 8);
  assert.equal(audioByConnection.length, 8);
  assert.ok(audioByConnection.every((chunks) => Buffer.concat(chunks).equals(Buffer.alloc(1_920))));
  for (const configuration of configurations) {
    assert.equal("endpoint_latency_adjustment_level" in configuration, false);
    assert.equal("endpoint_sensitivity" in configuration, false);
  }
  const [baselineConfiguration, contextConfigurationMessage, endpointConfiguration,
    contextEndpointConfiguration] = configurations;
  assert.ok(baselineConfiguration);
  assert.ok(contextConfigurationMessage);
  assert.ok(endpointConfiguration);
  assert.ok(contextEndpointConfiguration);
  assert.deepEqual(baselineConfiguration.context, {
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
  const contextConfiguration = contextConfigurationMessage.context as Record<string, unknown>;
  assert.ok(Array.isArray(contextConfiguration.general));
  assert.deepEqual(contextConfiguration, {
    general: contextConfiguration.general,
    terms: ["ヴァロラント", "발로란트"],
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
  assert.deepEqual(endpointConfiguration.context, baselineConfiguration.context);
  assert.deepEqual(contextEndpointConfiguration.context, contextConfigurationMessage.context);
  assert.equal("max_endpoint_delay_ms" in baselineConfiguration, false);
  assert.equal("max_endpoint_delay_ms" in contextConfigurationMessage, false);
  assert.equal(endpointConfiguration.max_endpoint_delay_ms, 500);
  assert.equal(contextEndpointConfiguration.max_endpoint_delay_ms, 500);
});

void test("大量挿入triage runnerを直接呼んでも未監査音声では接続しない", async () => {
  let connectionCount = 0;
  await withServer(() => {
    connectionCount += 1;
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "insertion-triage-pending-dataset"),
    ));
    const auditPath = writePendingAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-pending-audit"),
      ["ja-term"],
    );

    await assert.rejects(
      runSttInsertionTriageDataset(dataset, {
        apiKey: "do-not-leak-api-key",
        model: "stt-rt-v5",
        sttWebSocketUrl: url,
        caseIds: ["ja-term"],
        audioAuditPath: auditPath,
        trials: 1,
      }),
      /verified/u,
    );
  });

  assert.equal(connectionCount, 0);
});

void test("大量挿入triage runnerは共有可能な監査directoryから接続しない", async () => {
  let connectionCount = 0;
  await withServer(() => {
    connectionCount += 1;
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "insertion-triage-shared-audit-dataset"),
    ));
    const auditDirectory = path.join(temporaryDirectory, "insertion-triage-shared-audit");
    const audit = await writeVerifiedAudioAudit(dataset, auditDirectory, ["ja-term"]);
    chmodSync(auditDirectory, 0o777);

    await assert.rejects(
      runSttInsertionTriageDataset(dataset, {
        apiKey: "do-not-leak-api-key",
        model: "stt-rt-v5",
        sttWebSocketUrl: url,
        caseIds: ["ja-term"],
        audioAuditPath: audit.auditPath,
        trials: 1,
      }),
      /private directory.*0700/u,
    );
  });

  assert.equal(connectionCount, 0);
});

void test("大量挿入triage runnerを直接呼んでも共有可能なdatasetでは接続しない", async () => {
  let connectionCount = 0;
  await withServer((socket) => {
    connectionCount += 1;
    handleSuccessfulSttConnection(socket);
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "insertion-triage-shared-dataset"),
    ));
    const audioAudit = await writeVerifiedAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-private-audit"),
      ["ja-term"],
    );
    const evaluationCase = dataset.cases[0];
    assert.ok(evaluationCase);
    chmodSync(evaluationCase.audioPath, 0o644);

    await assert.rejects(
      runSttInsertionTriageDataset(dataset, {
        apiKey: "do-not-leak-api-key",
        model: "stt-rt-v5",
        sttWebSocketUrl: url,
        caseIds: ["ja-term"],
        audioAuditPath: audioAudit.auditPath,
        trials: 1,
      }),
      /PCM.*0600/u,
    );
  });

  assert.equal(connectionCount, 0);
});

void test("大量挿入triageは旧baseline PとPCM・Opus×翻訳有無を分離する", async () => {
  const configurations: Record<string, unknown>[] = [];
  const audioByConnection: Buffer[][] = [];
  const finalizeMessages: Record<string, unknown>[] = [];
  await withServer((socket) => {
    const audio: Buffer[] = [];
    audioByConnection.push(audio);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        audio.push(Buffer.from(data as Buffer));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 220,
          total_audio_proc_ms: 220,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) {
        configurations.push(message);
        return;
      }
      if (message.type === "finalize") {
        finalizeMessages.push(message);
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<fin>", is_final: true },
          ],
          final_audio_proc_ms: 220,
          total_audio_proc_ms: 220,
        }));
      }
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "insertion-triage-dataset"),
    ));
    const audioAudit = await writeVerifiedAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-audit"),
      ["ja-term"],
    );
    const result = await runSttInsertionTriageDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      caseIds: ["ja-term"],
      audioAuditPath: audioAudit.auditPath,
      trials: 1,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });

    assert.deepEqual(result.results.map((entry) => entry.condition), [
      "historical_baseline",
      "pcm_stt_only",
      "pcm_translation",
      "opus_stt_only",
      "opus_translation",
    ]);
    for (const entry of result.results) {
      assert.equal(entry.input_audit.source_packet_send_count, 1);
      assert.equal(entry.input_audit.duplicate_source_packet_index_count, 0);
      assert.equal(entry.input_audit.missing_source_packet_count, 0);
      assert.equal(entry.input_audit.send_audio_call_count, 2);
      assert.equal(entry.input_audit.trailing_silence_ms, 200);
      assert.equal(entry.input_audit.finalize_call_count, 1);
      assert.equal(entry.input_audit.endpoint_event_count, 0);
      assert.equal(entry.input_audit.finalized_event_count, 1);
      assert.equal(entry.transcript, "ヴァロラント");
    }
    assert.equal(result.results[0]?.input_audit.opus_packet_count, null);
    assert.equal(result.results[1]?.input_audit.opus_packet_count, null);
    assert.equal(result.results[2]?.input_audit.opus_packet_count, null);
    assert.equal(result.results[3]?.input_audit.opus_packet_count, 1);
    assert.equal(result.results[4]?.input_audit.opus_packet_count, 1);
    assert.ok(result.results.every((entry) => entry.original_final_tokens[0]?.received_at_ms !== undefined));
    assert.doesNotMatch(JSON.stringify(result), /do-not-leak-api-key/u);
  });

  assert.equal(configurations.length, 5);
  assert.equal(audioByConnection.length, 5);
  assert.equal(finalizeMessages.length, 5);
  assert.ok(finalizeMessages.every((message) => message.trailing_silence_ms === 200));
  const positiveControl = configurations[0];
  assert.ok(positiveControl);
  assert.equal(positiveControl.enable_endpoint_detection, true);
  assert.deepEqual(positiveControl.context, {
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
  assert.deepEqual(positiveControl.translation, {
    type: "two_way",
    language_a: "ja",
    language_b: "ko",
  });
  for (const configuration of configurations.slice(1)) {
    assert.equal(configuration.enable_endpoint_detection, false);
    assert.equal("context" in configuration, false);
  }
  assert.equal("translation" in (configurations[1] ?? {}), false);
  const pcmTranslation = configurations[2];
  const opusTranslation = configurations[4];
  assert.ok(pcmTranslation);
  assert.ok(opusTranslation);
  assert.deepEqual(pcmTranslation.translation, {
    type: "two_way",
    language_a: "ja",
    language_b: "ko",
  });
  assert.equal("translation" in (configurations[3] ?? {}), false);
  assert.deepEqual(opusTranslation.translation, pcmTranslation.translation);
  assert.ok(audioByConnection.every((chunks) => chunks.length === 2));
  assert.ok(audioByConnection.every((chunks) => chunks[1]?.equals(Buffer.alloc(19_200))));
});

void test("陽性対照PはSoniox endpointが先なら手動finalizeを呼ばない", async () => {
  await withServer((socket) => {
    let endpointDetectionEnabled = false;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!endpointDetectionEnabled) return;
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 220,
          total_audio_proc_ms: 220,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) {
        endpointDetectionEnabled = message.enable_endpoint_detection === true;
        return;
      }
      if (message.type !== "finalize") return;
      socket.send(JSON.stringify({
        tokens: [
          {
            text: "ヴァロラント",
            is_final: true,
            confidence: 0.95,
            language: "ja",
            translation_status: "original",
            start_ms: 0,
            end_ms: 20,
          },
          { text: "<fin>", is_final: true },
        ],
        final_audio_proc_ms: 220,
        total_audio_proc_ms: 220,
      }));
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "insertion-triage-endpoint-dataset"),
    ));
    const audioAudit = await writeVerifiedAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-endpoint-audit"),
      ["ja-term"],
    );
    const result = await runSttInsertionTriageDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      caseIds: ["ja-term"],
      audioAuditPath: audioAudit.auditPath,
      trials: 1,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });

    const positiveControl = result.results[0];
    assert.equal(positiveControl?.condition, "historical_baseline");
    assert.equal(positiveControl.input_audit.finalize_call_count, 0);
    assert.equal(positiveControl.input_audit.trailing_silence_ms, 0);
    assert.equal(positiveControl.input_audit.send_audio_call_count, 1);
    assert.equal(positiveControl.input_audit.endpoint_event_count, 1);
    assert.equal(positiveControl.accepted_boundaries.at(-1)?.kind, "endpoint");
    assert.equal(positiveControl.accepted_boundaries.at(-1)?.reason, "soniox_endpoint");
    for (const entry of result.results.slice(1)) {
      assert.equal(entry.input_audit.finalize_call_count, 1);
      assert.equal(entry.input_audit.trailing_silence_ms, 200);
    }
  });
});

void test("陽性対照Pは旧baselineどおり複数確定と重複final tokenを再現して記録する", async () => {
  await withServer((socket) => {
    let positiveControl = false;
    let finalizeCount = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 700,
          total_audio_proc_ms: 700,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) {
        positiveControl = message.enable_endpoint_detection === true;
        return;
      }
      if (message.type !== "finalize") return;
      finalizeCount += 1;
      const firstToken = {
        text: positiveControl && finalizeCount === 2 ? "後半" : "ヴァロラント",
        is_final: true,
        confidence: 0.95,
        language: "ja",
        translation_status: "original",
        start_ms: positiveControl && finalizeCount === 2 ? 20 : 0,
        end_ms: positiveControl && finalizeCount === 2 ? 40 : 20,
      };
      socket.send(JSON.stringify({
        tokens: positiveControl && finalizeCount === 1
          ? [firstToken, { ...firstToken }, { text: "<fin>", is_final: true }]
          : [firstToken, { text: "<fin>", is_final: true }],
        final_audio_proc_ms: 700,
        total_audio_proc_ms: 700,
      }));
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeGapDataset(
      path.join(temporaryDirectory, "insertion-triage-gap-dataset"),
    ));
    const audioAudit = await writeVerifiedAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-gap-audit"),
      ["ja-term"],
    );
    const result = await runSttInsertionTriageDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      caseIds: ["ja-term"],
      audioAuditPath: audioAudit.auditPath,
      trials: 1,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });

    const positiveControl = result.results[0];
    assert.equal(positiveControl?.condition, "historical_baseline");
    assert.equal(positiveControl.input_audit.finalize_call_count, 2);
    assert.equal(positiveControl.input_audit.trailing_silence_ms, 400);
    assert.equal(positiveControl.input_audit.send_audio_call_count, 4);
    assert.equal(positiveControl.duplicate_final_original_token_count, 1);
    assert.equal(positiveControl.accepted_boundaries.length, 2);
    assert.equal(positiveControl.transcript, "ヴァロラントヴァロラント後半");
    for (const entry of result.results.slice(1)) {
      assert.equal(entry.input_audit.finalize_call_count, 1);
      assert.equal(entry.duplicate_final_original_token_count, 0);
    }
  });
});

void test("大量挿入triage CLIはprivate観測と本文非含有reportを0600で保存する", async () => {
  const outputDirectory = path.join(temporaryDirectory, "insertion-triage-cli-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 220,
          total_audio_proc_ms: 220,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type !== "finalize") return;
      socket.send(JSON.stringify({
        tokens: [
          {
            text: "ヴァロラント",
            is_final: true,
            confidence: 0.95,
            language: "ja",
            translation_status: "original",
            start_ms: 0,
            end_ms: 20,
          },
          { text: "<fin>", is_final: true },
        ],
        final_audio_proc_ms: 220,
        total_audio_proc_ms: 220,
      }));
    });
  }, async (url) => {
    const manifestPath = writeDataset(
      path.join(temporaryDirectory, "insertion-triage-cli-dataset"),
    );
    const dataset = await loadSttEvaluationDataset(manifestPath);
    const audioAudit = await writeVerifiedAudioAudit(
      dataset,
      path.join(temporaryDirectory, "insertion-triage-cli-audit"),
      ["ja-term"],
    );
    const result = await runEvaluationCli([
      "triage-insertions",
      "--manifest",
      manifestPath,
      "--audio-audit",
      audioAudit.auditPath,
      "--cases",
      "ja-term",
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--stt-websocket-url",
      url,
      "--trials",
      "1",
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-leak-api-key|ヴァロラント/u);
    assert.deepEqual(JSON.parse(result.stdout), {
      observations_written: true,
      report_written: true,
      experiment: "insertion_triage",
      case_count: 1,
      trial_count: 1,
      observation_count: 5,
      decision: "no_production_change",
    });
  });

  const observationsText = readFileSync(observationsPath, "utf8");
  const reportText = readFileSync(reportPath, "utf8");
  assert.match(observationsText, /ヴァロラント|original_final_tokens/u);
  assert.doesNotMatch(
    reportText,
    /ヴァロラント|do-not-leak-api-key|"transcript":|"original_final_tokens":/u,
  );
  assert.equal(statSync(observationsPath).mode & 0o777, 0o600);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
});

void test("評価runnerはinterim・翻訳・制御tokenをCER本文へ追加しない", async () => {
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "途中候補",
              is_final: false,
              confidence: 0.4,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 10,
            },
            {
              text: "중간 번역",
              is_final: true,
              confidence: 0.9,
              language: "ko",
              source_language: "ja",
              translation_status: "translation",
            },
          ],
          final_audio_proc_ms: 0,
          total_audio_proc_ms: 10,
        }));
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      if (rawDataToUtf8(data).length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
      }
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "token-filter-dataset"),
    ));
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      profiles: ["baseline"],
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });

    const result = observations.results[0];
    assert.ok(result);
    assert.equal(result.transcript, "ヴァロラント");
    assert.deepEqual(result.recognized_languages, ["ja"]);
    assert.equal(result.audio_metrics?.original_token_count, 1);
  });
});

void test("評価runnerは同じ時刻のfinal原文token再送をFail Fastで拒否する", async () => {
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const repeatedToken = {
          text: "ヴァロラント",
          is_final: true,
          confidence: 0.95,
          language: "ja",
          translation_status: "original",
          start_ms: 0,
          end_ms: 20,
        };
        socket.send(JSON.stringify({
          tokens: [repeatedToken],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        socket.send(JSON.stringify({
          tokens: [repeatedToken, { text: "<end>", is_final: true }],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      if (rawDataToUtf8(data).length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
      }
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset(
      path.join(temporaryDirectory, "duplicate-final-token-dataset"),
    ));
    await assert.rejects(
      () => runSttEvaluationDataset(dataset, {
        apiKey: "do-not-leak-api-key",
        model: "stt-rt-v5",
        sttWebSocketUrl: url,
        profiles: ["baseline"],
        boundaryTimeoutMs: 1_000,
        finishTimeoutMs: 1_000,
      }),
      /同じ時刻のfinal原文tokenが重複/u,
    );
  });
});

void test("認識用terms実験はgeneralを送らず両言語版とsource限定版を分離する", async () => {
  const configurations: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      experiment: "recognition_terms",
      trials: 1,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });
    const report = createSttEvaluationReport(dataset.manifest, observations);

    assert.deepEqual(observations.results.map((result) => result.profile), [
      "baseline",
      "recognition_terms",
    ]);
    assert.deepEqual(report.profile_mapping, {
      A: "baseline",
      B: "recognition_terms",
    });

    const sourceOnlyObservations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      experiment: "recognition_source_terms",
      trials: 1,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });
    const sourceOnlyReport = createSttEvaluationReport(
      dataset.manifest,
      sourceOnlyObservations,
    );
    assert.deepEqual(sourceOnlyObservations.results.map((result) => result.profile), [
      "baseline",
      "recognition_source_terms",
    ]);
    assert.deepEqual(sourceOnlyReport.profile_mapping, {
      A: "baseline",
      B: "recognition_source_terms",
    });
  });

  assert.equal(configurations.length, 4);
  const [baseline, recognitionTerms, sourceOnlyBaseline, recognitionSourceTerms] =
    configurations;
  assert.ok(baseline);
  assert.ok(recognitionTerms);
  assert.ok(sourceOnlyBaseline);
  assert.ok(recognitionSourceTerms);
  assert.deepEqual(baseline.context, {
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
  assert.deepEqual(recognitionTerms.context, {
    terms: ["ヴァロラント", "발로란트"],
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
  assert.deepEqual(sourceOnlyBaseline.context, baseline.context);
  assert.deepEqual(recognitionSourceTerms.context, {
    terms: ["ヴァロラント"],
    translation_terms: [{ source: "ヴァロラント", target: "발로란트" }],
  });
});

void test("run CLIは指定試行数のA〜Dを実行し、本文をlocal観測結果だけへ0600で保存する", async () => {
  const outputDirectory = path.join(temporaryDirectory, "cli-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  await withServer(handleSuccessfulSttConnection, async (url) => {
    const result = await runEvaluationCli([
      "run",
      "--manifest",
      writeDataset(),
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--stt-websocket-url",
      url,
      "--trials",
      "2",
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-leak-api-key|ヴァロラント/u);
    assert.equal((JSON.parse(result.stdout) as { trial_count: number }).trial_count, 2);
  });

  const observationsText = readFileSync(observationsPath, "utf8");
  const reportText = readFileSync(reportPath, "utf8");
  const observations = JSON.parse(observationsText) as {
    results: { trial: number }[];
  };
  const report = JSON.parse(reportText) as {
    profiles: { endpoint: { configuration: { soniox_max_endpoint_delay_ms: number } } };
  };
  assert.equal(observations.results.length, 8);
  assert.deepEqual([...new Set(observations.results.map((entry) => entry.trial))], [1, 2]);
  assert.equal(report.profiles.endpoint.configuration.soniox_max_endpoint_delay_ms, 500);
  assert.match(observationsText, /ヴァロラント/u);
  assert.doesNotMatch(reportText, /ヴァロラント|do-not-leak-api-key/u);
  assert.equal(statSync(observationsPath).mode & 0o777, 0o600);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
});

void test("run CLIはendpoint timing実験の既定batchをA〜Dに限定する", async () => {
  const outputDirectory = path.join(temporaryDirectory, "endpoint-timing-cli-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  await withServer(handleSuccessfulSttConnection, async (url) => {
    const result = await runEvaluationCli([
      "run",
      "--manifest",
      writeDataset(),
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--experiment",
      "endpoint_timing",
      "--stt-websocket-url",
      url,
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    const standardOutput = JSON.parse(result.stdout) as {
      experiment: string;
      profiles: string[];
    };
    assert.equal(standardOutput.experiment, "endpoint_timing");
    assert.deepEqual(standardOutput.profiles, [
      "baseline",
      "endpoint_fallback_400",
      "endpoint_fallback_600",
      "endpoint_fallback_800",
    ]);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-leak-api-key|ヴァロラント/u);
  });

  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as {
    experiment: string;
    results: { profile: string; configuration: { manual_finalize_fallback_ms: number | null } }[];
  };
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    experiment: string;
    profile_mapping: Record<string, string>;
  };
  assert.equal(observations.experiment, "endpoint_timing");
  assert.equal(observations.results.length, 4);
  assert.equal(
    observations.results.find((entry) => entry.profile === "endpoint_fallback_400")
      ?.configuration.manual_finalize_fallback_ms,
    300,
  );
  assert.equal(report.experiment, "endpoint_timing");
  assert.equal(report.profile_mapping.E, "endpoint_only_1000");

  const rejected = await runEvaluationCli([
    "run",
    "--manifest",
    writeDataset(),
    "--observations-output",
    path.join(outputDirectory, "rejected-observations.json"),
    "--output",
    path.join(outputDirectory, "rejected-report.json"),
    "--experiment",
    "endpoint_timing",
    "--profiles",
    "baseline,endpoint_only_1000",
    "--stt-websocket-url",
    "ws://127.0.0.1:9",
  ], {
    ...process.env,
    SONIOX_API_KEY: "do-not-leak-api-key",
    SONIOX_STT_MODEL: "stt-rt-v5",
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /endpoint_only_1000.*probe-endpoint-only/u);
  assert.equal(existsSync(path.join(outputDirectory, "rejected-observations.json")), false);
});

void test("run CLIは400ms fallbackを固定してendpoint latency level 0と1だけを比較する", async () => {
  const outputDirectory = path.join(temporaryDirectory, "endpoint-latency-level-cli-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  const configurations: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const result = await runEvaluationCli([
      "run",
      "--manifest",
      writeDataset(),
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--experiment",
      "endpoint_latency_level",
      "--stt-websocket-url",
      url,
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    const standardOutput = JSON.parse(result.stdout) as {
      experiment: string;
      profiles: string[];
    };
    assert.equal(standardOutput.experiment, "endpoint_latency_level");
    assert.deepEqual(standardOutput.profiles, [
      "baseline",
      "endpoint_fallback_400",
      "endpoint_fallback_400_level1",
    ]);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-leak-api-key|ヴァロラント/u);
  });

  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as {
    experiment: string;
    results: {
      profile: string;
      configuration: {
        manual_finalize_fallback_ms: number | null;
        soniox_endpoint_latency_adjustment_level: number | null;
      };
    }[];
  };
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    experiment: string;
    profile_mapping: Record<string, string>;
  };
  assert.equal(observations.experiment, "endpoint_latency_level");
  assert.deepEqual(observations.results.map((entry) => entry.profile), [
    "baseline",
    "endpoint_fallback_400",
    "endpoint_fallback_400_level1",
  ]);
  assert.deepEqual(
    observations.results.map((entry) => entry.configuration.manual_finalize_fallback_ms),
    [100, 300, 300],
  );
  assert.deepEqual(
    observations.results.map(
      (entry) => entry.configuration.soniox_endpoint_latency_adjustment_level,
    ),
    [null, 0, 1],
  );
  assert.deepEqual(report.profile_mapping, {
    A: "baseline",
    B: "endpoint_fallback_400",
    C: "endpoint_fallback_400_level1",
  });
  assert.equal(report.experiment, "endpoint_latency_level");

  assert.equal(configurations.length, 3);
  assert.equal("endpoint_latency_adjustment_level" in (configurations[0] ?? {}), false);
  assert.equal(configurations[1]?.endpoint_latency_adjustment_level, 0);
  assert.equal(configurations[2]?.endpoint_latency_adjustment_level, 1);
  for (const configuration of configurations.slice(1)) {
    assert.equal(configuration.max_endpoint_delay_ms, 1_000);
    assert.equal(configuration.endpoint_sensitivity, 0);
  }
});

void test("固有名詞カタログ実験はlevel 1へ全case共通termsだけを加える", async () => {
  const outputDirectory = path.join(temporaryDirectory, "recognition-catalog-cli-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  const manifestPath = writeRecognitionCatalogDataset();
  const configurations: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "テスト固有語アルファ DemoVoice",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const result = await runEvaluationCli([
      "run",
      "--manifest",
      manifestPath,
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--experiment",
      "recognition_catalog_level1",
      "--stt-websocket-url",
      url,
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    const standardOutput = JSON.parse(result.stdout) as {
      experiment: string;
      profiles: string[];
    };
    assert.equal(standardOutput.experiment, "recognition_catalog_level1");
    assert.deepEqual(standardOutput.profiles, [
      "baseline",
      "endpoint_fallback_400_level1",
      "endpoint_fallback_400_level1_catalog_terms",
    ]);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /do-not-leak-api-key|テスト固有語アルファ|테스트고유어베타|DemoVoice/u,
    );
  });

  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as {
    experiment: string;
    results: { profile: string }[];
  };
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    experiment: string;
    profile_mapping: Record<string, string>;
  };
  assert.equal(observations.experiment, "recognition_catalog_level1");
  assert.deepEqual(observations.results.map((result) => result.profile), [
    "baseline",
    "endpoint_fallback_400_level1",
    "endpoint_fallback_400_level1_catalog_terms",
    "endpoint_fallback_400_level1",
    "endpoint_fallback_400_level1_catalog_terms",
    "baseline",
  ]);
  assert.equal(report.experiment, "recognition_catalog_level1");
  assert.deepEqual(report.profile_mapping, {
    A: "baseline",
    B: "endpoint_fallback_400_level1",
    C: "endpoint_fallback_400_level1_catalog_terms",
  });
  assert.equal(statSync(observationsPath).mode & 0o777, 0o600);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);

  assert.equal(configurations.length, 6);
  const catalogConfigurations = configurations.filter((configuration) => {
    const context = configuration.context as { terms?: unknown } | undefined;
    return context?.terms !== undefined;
  });
  assert.equal(catalogConfigurations.length, 2);
  for (const configuration of catalogConfigurations) {
    const context = configuration.context as Record<string, unknown>;
    assert.deepEqual(context.terms, [
      "テスト固有語アルファ",
      "DemoVoice",
      "테스트고유어베타",
    ]);
    assert.equal("general" in context, false);
    assert.equal(configuration.endpoint_latency_adjustment_level, 1);
    assert.equal(configuration.max_endpoint_delay_ms, 1_000);
  }
  assert.deepEqual(
    catalogConfigurations.map((configuration) =>
      (configuration.context as Record<string, unknown>).translation_terms
    ),
    [
      [{ source: "テスト翻訳元", target: "테스트번역대상" }],
      [{ source: "테스트번역원문", target: "Test Translation Target" }],
    ],
  );
  for (const configuration of configurations.filter(
    (configuration) => !catalogConfigurations.includes(configuration),
  )) {
    const context = configuration.context as Record<string, unknown> | undefined;
    assert.equal(context === undefined || !("terms" in context), true);
  }
});

void test("固有名詞カタログ直交実験はtermsとlevel 1を同一batchで分離する", async () => {
  const outputDirectory = path.join(temporaryDirectory, "recognition-catalog-factorial-output");
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(outputDirectory, "report.json");
  const manifestPath = writeRecognitionCatalogDataset(
    path.join(temporaryDirectory, "recognition-catalog-factorial-dataset"),
  );
  const configurations: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "テスト固有語アルファ DemoVoice",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const result = await runEvaluationCli([
      "run",
      "--manifest",
      manifestPath,
      "--observations-output",
      observationsPath,
      "--output",
      reportPath,
      "--experiment",
      "recognition_catalog_factorial",
      "--stt-websocket-url",
      url,
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /do-not-leak-api-key|テスト固有語アルファ|테스트고유어베타|DemoVoice/u,
    );
  });

  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as {
    experiment: string;
    results: { profile: string }[];
  };
  const factorialReport = JSON.parse(readFileSync(reportPath, "utf8")) as {
    experiment: string;
    profile_mapping: Record<string, string>;
    comparisons: Record<string, { gates: { semantic_endpoint: string } }>;
  };
  assert.equal(observations.experiment, "recognition_catalog_factorial");
  assert.deepEqual(factorialReport.profile_mapping, {
    A: "baseline",
    B: "recognition_catalog_terms",
    C: "endpoint_fallback_400_level1",
    D: "endpoint_fallback_400_level1_catalog_terms",
  });
  assert.deepEqual(
    Object.values(factorialReport.comparisons).map((comparison) => (
      comparison.gates.semantic_endpoint
    )),
    ["not_evaluated", "not_evaluated", "not_evaluated"],
  );
  assert.deepEqual(observations.results.map((result) => result.profile), [
    "baseline",
    "recognition_catalog_terms",
    "endpoint_fallback_400_level1",
    "endpoint_fallback_400_level1_catalog_terms",
    "recognition_catalog_terms",
    "endpoint_fallback_400_level1",
    "endpoint_fallback_400_level1_catalog_terms",
    "baseline",
  ]);
  assert.equal(statSync(observationsPath).mode & 0o777, 0o600);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);

  assert.equal(configurations.length, 8);
  const configurationKinds = configurations.map((configuration) => {
    const context = configuration.context as Record<string, unknown> | undefined;
    const hasTerms = context?.terms !== undefined;
    const hasLevel1 = configuration.endpoint_latency_adjustment_level === 1;
    if (hasTerms && hasLevel1) return "terms_level1";
    if (hasTerms) return "terms";
    if (hasLevel1) return "level1";
    return "none";
  });
  assert.deepEqual(configurationKinds, [
    "none",
    "terms",
    "level1",
    "terms_level1",
    "terms",
    "level1",
    "terms_level1",
    "none",
  ]);
  for (const configuration of configurations.filter((_, index) => (
    configurationKinds[index] === "terms" || configurationKinds[index] === "terms_level1"
  ))) {
    const context = configuration.context as Record<string, unknown>;
    assert.deepEqual(context.terms, [
      "テスト固有語アルファ",
      "DemoVoice",
      "테스트고유어베타",
    ]);
    assert.equal("general" in context, false);
    assert.ok(Array.isArray(context.translation_terms));
  }
});

void test("endpoint候補でmanual fallbackが勝った境界を記録し、Soniox中心とは判定しない", async () => {
  let finalizeRequestCount = 0;
  await withServer((socket) => {
    let audioMessageCount = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        audioMessageCount += 1;
        if (audioMessageCount === 1) {
          socket.send(JSON.stringify({
            tokens: [{
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            }],
            final_audio_proc_ms: 20,
            total_audio_proc_ms: 20,
          }));
        }
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as { type?: string };
      if (message.type === "finalize") {
        finalizeRequestCount += 1;
        socket.send(JSON.stringify({
          tokens: [{ text: "<fin>", is_final: true }],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
      }
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      profiles: ["baseline", "endpoint"],
      boundaryTimeoutMs: 2_000,
      finishTimeoutMs: 1_000,
    });

    const finalization = observations.results
      .find((result) => result.profile === "endpoint")?.finalizations[0];
    assert.ok(finalization);
    assert.equal(finalization.kind, "finalized");
    assert.equal(finalization.reason, "speaking_end");
    const report = createSttEvaluationReport(dataset.manifest, observations);
    assert.equal(report.comparisons.endpoint?.gates.semantic_endpoint, "not_evaluated");
  });
  assert.equal(finalizeRequestCount, 2);
});

void test("endpoint timing A〜Eは合計400〜800msのfallbackとendpoint-onlyをwireへ分離する", async () => {
  const configurations: Record<string, unknown>[] = [];
  const finalizeRequestCounts = [0, 0, 0, 0, 0];
  const audioBytesByConnection = [0, 0, 0, 0, 0];
  let connectionCount = 0;
  await withServer((socket) => {
    const connectionIndex = connectionCount;
    connectionCount += 1;
    let endpointSent = false;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const currentAudioBytes = audioBytesByConnection[connectionIndex];
        if (currentAudioBytes === undefined) {
          throw new Error("評価音声の接続indexを解決できませんでした");
        }
        const audio = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        audioBytesByConnection[connectionIndex] = currentAudioBytes + audio.length;
        if (
          connectionIndex === 4 &&
          !endpointSent &&
          audioBytesByConnection[connectionIndex] >= 1_920 + 19_200
        ) {
          endpointSent = true;
          socket.send(JSON.stringify({
            tokens: [
              {
                text: "ヴァロラント",
                is_final: true,
                confidence: 0.95,
                language: "ja",
                translation_status: "original",
                start_ms: 0,
                end_ms: 20,
              },
              { text: "<end>", is_final: true },
            ],
            final_audio_proc_ms: 220,
            total_audio_proc_ms: 220,
          }));
        }
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) {
        configurations.push(message);
        return;
      }
      if (message.type === "finalize") {
        const currentCount = finalizeRequestCounts[connectionIndex];
        if (currentCount === undefined) throw new Error("評価接続indexを解決できませんでした");
        finalizeRequestCounts[connectionIndex] = currentCount + 1;
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<fin>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
      }
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      experiment: "endpoint_timing",
      profiles: [
        "baseline",
        "endpoint_fallback_400",
        "endpoint_fallback_600",
        "endpoint_fallback_800",
        "endpoint_only_1000",
      ],
      boundaryTimeoutMs: 2_000,
      finishTimeoutMs: 1_000,
    });
    const parsed = parseSttEvaluationObservations(JSON.stringify(observations));
    const report = createSttEvaluationReport(dataset.manifest, parsed);

    assert.equal(observations.experiment, "endpoint_timing");
    assert.deepEqual(observations.results.map((result) => result.profile), [
      "baseline",
      "endpoint_fallback_400",
      "endpoint_fallback_600",
      "endpoint_fallback_800",
      "endpoint_only_1000",
    ]);
    assert.deepEqual(
      observations.results.map((result) => result.configuration.manual_finalize_fallback_ms),
      [100, 300, 500, 700, null],
    );
    assert.deepEqual(
      observations.results.map((result) => result.configuration.endpoint_silence_chunk_ms),
      [null, 20, 20, 20, 20],
    );
    assert.deepEqual(finalizeRequestCounts, [1, 1, 1, 1, 0]);
    assert.ok((audioBytesByConnection[4] ?? 0) >= 1_920 + 19_200);
    for (const [index, expectedLatencyMs] of [200, 400, 600, 800].entries()) {
      const latencyMs = observations.results[index]?.finalizations.find((finalization) => (
        finalization.reason === "speaking_end"
      ))?.latency_ms;
      assert.ok(latencyMs !== undefined);
      assert.ok(
        latencyMs >= expectedLatencyMs - 50 && latencyMs <= expectedLatencyMs + 250,
        `profile index ${String(index)}の確定遅延${String(latencyMs)}msが期待範囲外です`,
      );
    }
    assert.equal(
      observations.results[4]?.finalizations[0]?.reason,
      "soniox_endpoint",
    );
    assert.deepEqual(report.profile_mapping, {
      A: "baseline",
      B: "endpoint_fallback_400",
      C: "endpoint_fallback_600",
      D: "endpoint_fallback_800",
      E: "endpoint_only_1000",
    });
    assert.equal(report.experiment, "endpoint_timing");
    assert.equal(
      report.profiles.endpoint_only_1000?.finalization.manual_fallback_count,
      0,
    );
  });

  assert.equal(configurations.length, 5);
  for (const [index, configuration] of configurations.entries()) {
    if (index === 0) {
      assert.equal("max_endpoint_delay_ms" in configuration, false);
      assert.equal("endpoint_latency_adjustment_level" in configuration, false);
      assert.equal("endpoint_sensitivity" in configuration, false);
      continue;
    }
    assert.equal(configuration.max_endpoint_delay_ms, 1_000);
    assert.equal(configuration.endpoint_latency_adjustment_level, 0);
    assert.equal(configuration.endpoint_sensitivity, 0);
  }
});

void test("contextと400ms endpoint候補を組み合わせても認識用語と翻訳用語をwireで分離する", async () => {
  const configurations: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
            { text: "<end>", is_final: true },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.api_key !== undefined) configurations.push(message);
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    const observations = await runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: url,
      experiment: "context_endpoint_400",
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
    });
    const report = createSttEvaluationReport(
      dataset.manifest,
      parseSttEvaluationObservations(JSON.stringify(observations)),
    );

    assert.deepEqual(observations.results.map((result) => result.profile), [
      "baseline",
      "endpoint_fallback_400",
      "context_endpoint_fallback_400",
    ]);
    assert.deepEqual(report.profile_mapping, {
      A: "baseline",
      B: "endpoint_fallback_400",
      C: "context_endpoint_fallback_400",
    });
  });

  assert.equal(configurations.length, 3);
  const [baseline, endpoint, contextEndpoint] = configurations;
  assert.ok(baseline);
  assert.ok(endpoint);
  assert.ok(contextEndpoint);
  assert.deepEqual(endpoint.context, baseline.context);
  const context = contextEndpoint.context as Record<string, unknown>;
  assert.ok(Array.isArray(context.general));
  assert.deepEqual(context.terms, ["ヴァロラント", "발로란트"]);
  assert.deepEqual(context.translation_terms, [
    { source: "ヴァロラント", target: "발로란트" },
  ]);
  assert.equal(contextEndpoint.max_endpoint_delay_ms, 1_000);
  assert.equal(contextEndpoint.endpoint_latency_adjustment_level, 0);
  assert.equal(contextEndpoint.endpoint_sensitivity, 0);
});

void test("endpoint-onlyはtoken停滞でもmanual finalizeせず外側timeoutで失敗する", async () => {
  let finalizeRequestCount = 0;
  let tokenSent = false;
  await withServer((socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (tokenSent) return;
        tokenSent = true;
        socket.send(JSON.stringify({
          tokens: [
            {
              text: "ヴァロラント",
              is_final: true,
              confidence: 0.95,
              language: "ja",
              translation_status: "original",
              start_ms: 0,
              end_ms: 20,
            },
          ],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
        }));
        return;
      }
      const text = rawDataToUtf8(data);
      if (text.length === 0) {
        socket.send(JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 20,
          total_audio_proc_ms: 20,
          finished: true,
        }));
        return;
      }
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type !== "finalize") return;
      finalizeRequestCount += 1;
      socket.send(JSON.stringify({
        tokens: [{ text: "<fin>", is_final: true }],
        final_audio_proc_ms: 20,
        total_audio_proc_ms: 20,
      }));
    });
  }, async (url) => {
    const dataset = await loadSttEvaluationDataset(writeDataset());
    await assert.rejects(
      runSttEvaluationDataset(dataset, {
        apiKey: "do-not-leak-api-key",
        model: "stt-rt-v5",
        sttWebSocketUrl: url,
        experiment: "endpoint_timing",
        profiles: ["endpoint_only_1000"],
        boundaryTimeoutMs: 3_200,
        finishTimeoutMs: 1_000,
      }),
      /endpoint_only_1000.*timeout/u,
    );
  });

  assert.equal(finalizeRequestCount, 0);
});

void test("endpoint-only probe CLIは必須caseを3試行し、timeoutを本文なしで0600保存する", async () => {
  const outputPath = path.join(temporaryDirectory, "endpoint-only-probe.json");
  let connectionCount = 0;
  let finalizeRequestCount = 0;
  await withServer((socket) => {
    connectionCount += 1;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = rawDataToUtf8(data);
      if (text.length === 0) return;
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === "finalize") finalizeRequestCount += 1;
    });
  }, async (url) => {
    const result = await runEvaluationCli([
      "probe-endpoint-only",
      "--manifest",
      writeDataset(),
      "--required-case",
      "ja-term",
      "--output",
      outputPath,
      "--stt-websocket-url",
      url,
      "--trials",
      "3",
      "--boundary-timeout-ms",
      "25",
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /do-not-leak-api-key|ヴァロラント/u,
    );
  });

  const summaryText = readFileSync(outputPath, "utf8");
  const summary = JSON.parse(summaryText) as {
    profile: string;
    dataset: { case: { case_id: string; packet_count: number } };
    trials: {
      trial: number;
      outcome: string;
      boundary_timeout_ms: number;
      cpu_percent: number;
    }[];
    outcome: string;
    full_dataset_scoring_completed: boolean;
    observations_written: boolean;
    decision: string;
  };
  assert.equal(connectionCount, 3);
  assert.equal(finalizeRequestCount, 0);
  assert.equal(summary.profile, "endpoint_only_1000");
  assert.equal(summary.dataset.case.case_id, "ja-term");
  assert.equal(summary.dataset.case.packet_count, 1);
  assert.deepEqual(summary.trials.map((trial) => trial.trial), [1, 2, 3]);
  assert.ok(summary.trials.every((trial) => (
    trial.outcome === "boundary_timeout" &&
    trial.boundary_timeout_ms === 25 &&
    trial.cpu_percent >= 0
  )));
  assert.equal(summary.outcome, "repeated_boundary_timeout");
  assert.equal(summary.full_dataset_scoring_completed, false);
  assert.equal(summary.observations_written, false);
  assert.equal(summary.decision, "not_adopted");
  assert.doesNotMatch(
    summaryText,
    /"(?:transcript|reference|translation_terms|api_key|raw_audio)"|ヴァロラント/u,
  );
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);

  const invalidOutputPath = path.join(temporaryDirectory, "invalid-endpoint-only-probe.json");
  const invalidResult = await runEvaluationCli([
    "probe-endpoint-only",
    "--manifest",
    writeDataset(),
    "--required-case",
    "ja-term",
    "--output",
    invalidOutputPath,
    "--stt-websocket-url",
    "ws://127.0.0.1:9",
    "--trials",
    "2",
  ], {
    ...process.env,
    SONIOX_API_KEY: "do-not-leak-api-key",
    SONIOX_STT_MODEL: "stt-rt-v5",
  });
  assert.notEqual(invalidResult.status, 0);
  assert.match(invalidResult.stderr, /endpoint-only probe.*3試行/u);
  assert.equal(existsSync(invalidOutputPath), false);
});

void test("endpoint-only probe CLIでendpointを受理した場合は全case評価が必要と記録する", async () => {
  const outputPath = path.join(temporaryDirectory, "successful-endpoint-only-probe.json");
  await withServer(handleSuccessfulSttConnection, async (url) => {
    const result = await runEvaluationCli([
      "probe-endpoint-only",
      "--manifest",
      writeDataset(),
      "--required-case",
      "ja-term",
      "--output",
      outputPath,
      "--stt-websocket-url",
      url,
      "--trials",
      "3",
      "--boundary-timeout-ms",
      "1000",
    ], {
      ...process.env,
      SONIOX_API_KEY: "do-not-leak-api-key",
      SONIOX_STT_MODEL: "stt-rt-v5",
    });

    assert.equal(result.status, 0, result.stderr);
  });

  const summaryText = readFileSync(outputPath, "utf8");
  const summary = JSON.parse(summaryText) as {
    trials: { outcome: string; endpoint_latency_ms?: number }[];
    outcome: string;
    full_dataset_scoring_completed: boolean;
    decision: string;
  };
  assert.ok(summary.trials.every((trial) => (
    trial.outcome === "endpoint_observed" && (trial.endpoint_latency_ms ?? -1) >= 0
  )));
  assert.equal(summary.outcome, "endpoint_observed");
  assert.equal(summary.full_dataset_scoring_completed, false);
  assert.equal(summary.decision, "full_dataset_evaluation_required");
  assert.doesNotMatch(
    summaryText,
    /"(?:transcript|reference|translation_terms|api_key|raw_audio)"|ヴァロラント/u,
  );
});

void test("run CLIは本文入りobservationsの追跡可能pathを接続前に拒否する", async () => {
  const observationsPath = path.join(
    process.cwd(),
    "stt-evaluation-private-observations-test.json",
  );
  const reportPath = path.join(temporaryDirectory, "private-path-report.json");
  rmSync(observationsPath, { force: true });
  let connectionCount = 0;
  try {
    await withServer((socket) => {
      connectionCount += 1;
      handleSuccessfulSttConnection(socket);
    }, async (url) => {
      const result = await runEvaluationCli([
        "run",
        "--manifest",
        writeDataset(),
        "--observations-output",
        observationsPath,
        "--output",
        reportPath,
        "--stt-websocket-url",
        url,
      ], {
        ...process.env,
        SONIOX_API_KEY: "do-not-leak-api-key",
        SONIOX_STT_MODEL: "stt-rt-v5",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /observations.*\.data\/stt-eval/u);
    });
    assert.equal(connectionCount, 0);
    assert.equal(existsSync(observationsPath), false);
  } finally {
    rmSync(observationsPath, { force: true });
  }
});

void test("run CLIは本文入りobservationsを.data/stt-eval配下へ0600で保存する", async () => {
  const outputDirectory = path.join(
    process.cwd(),
    ".data",
    "stt-eval",
    "private-path-integration-output",
  );
  const observationsPath = path.join(outputDirectory, "observations.json");
  const reportPath = path.join(temporaryDirectory, "private-path-allowed-report.json");
  rmSync(outputDirectory, { recursive: true, force: true });
  try {
    await withServer(handleSuccessfulSttConnection, async (url) => {
      const result = await runEvaluationCli([
        "run",
        "--manifest",
        writeDataset(),
        "--observations-output",
        observationsPath,
        "--output",
        reportPath,
        "--stt-websocket-url",
        url,
      ], {
        ...process.env,
        SONIOX_API_KEY: "do-not-leak-api-key",
        SONIOX_STT_MODEL: "stt-rt-v5",
      });

      assert.equal(result.status, 0, result.stderr);
    });
    assert.equal(statSync(observationsPath).mode & 0o777, 0o600);
    assert.equal(statSync(outputDirectory).mode & 0o777, 0o700);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

void test("run CLIは.data/stt-eval内のgroup・otherが読める入力を接続前に拒否する", async () => {
  const datasetDirectory = path.join(
    process.cwd(),
    ".data",
    "stt-eval",
    "private-input-permission-integration",
  );
  const observationsPath = path.join(datasetDirectory, "observations.json");
  const reportPath = path.join(temporaryDirectory, "private-input-permission-report.json");
  rmSync(datasetDirectory, { recursive: true, force: true });
  mkdirSync(datasetDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = writeDataset(datasetDirectory);
  chmodSync(manifestPath, 0o600);
  chmodSync(path.join(datasetDirectory, "sample.packets.json"), 0o600);
  chmodSync(path.join(datasetDirectory, "sample.pcm"), 0o644);
  let connectionCount = 0;
  try {
    await withServer((socket) => {
      connectionCount += 1;
      handleSuccessfulSttConnection(socket);
    }, async (url) => {
      const result = await runEvaluationCli([
        "run",
        "--manifest",
        manifestPath,
        "--observations-output",
        observationsPath,
        "--output",
        reportPath,
        "--stt-websocket-url",
        url,
      ], {
        ...process.env,
        SONIOX_API_KEY: "do-not-leak-api-key",
        SONIOX_STT_MODEL: "stt-rt-v5",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PCM.*0600/u);
    });
    assert.equal(connectionCount, 0);
    assert.equal(existsSync(observationsPath), false);
  } finally {
    rmSync(datasetDirectory, { recursive: true, force: true });
  }
});

void test("試行数の範囲外はSonioxへ接続する前に拒否する", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset());

  await assert.rejects(
    runSttEvaluationDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: "ws://127.0.0.1:1",
      trials: 11,
    }),
    /trial数は1〜10/u,
  );
});
