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

import { loadSttEvaluationDataset } from "../src/evaluation/stt-evaluation-files.js";
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
    }
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
