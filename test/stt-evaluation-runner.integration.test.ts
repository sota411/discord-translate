import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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

import { loadSttEvaluationDataset } from "../src/evaluation/stt-evaluation-files.js";
import { runSttEvaluationDataset } from "../src/evaluation/stt-evaluation-runner.js";
import { createSttEvaluationReport } from "../src/evaluation/stt-evaluation.js";

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

function writeDataset(): string {
  const directory = path.join(temporaryDirectory, "dataset");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "sample.pcm"), Buffer.alloc(1_920));
  writeFileSync(path.join(directory, "sample.packets.json"), JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: 1_920 }],
  }));
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
  }));
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
    assert.equal(report.comparisons.endpoint?.gates.semantic_endpoint, "fail");
  });
  assert.equal(finalizeRequestCount, 2);
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
