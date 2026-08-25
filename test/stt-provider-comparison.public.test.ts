import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { StartStreamTranscriptionCommandInput } from "@aws-sdk/client-transcribe-streaming";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { loadSttEvaluationDataset } from "../src/evaluation/stt-evaluation-files.js";
import {
  runAmazonTranscribeEvaluationCase,
  type AmazonTranscribeStreamingSender,
} from "../src/evaluation/amazon-transcribe-evaluation-runner.js";
import { runSttProviderComparisonDataset } from "../src/evaluation/stt-evaluation-runner.js";
import {
  createSttEvaluationReport,
  parseSttEvaluationManifest,
  parseSttEvaluationObservations,
  sttEvaluationProfileConfigurations,
} from "../src/evaluation/stt-evaluation.js";

const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), "discord-stt-provider-comparison-test-"),
);
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function withSonioxServer(run: (url: string) => Promise<void>): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.send(JSON.stringify({
          tokens: [{
            text: "ヴァロラント",
            is_final: true,
            confidence: 0.95,
            language: "ja",
            translation_status: "original",
            start_ms: 0,
            end_ms: 20,
          }, { text: "<end>", is_final: true }],
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
  });
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

function manifestValue(pair: "ja-ko" | "ja-en" = "ja-ko") {
  return {
    version: 1,
    pair,
    audio: { format: "pcm_s16le", sample_rate: 48_000, channels: 1 },
    cases: [
      {
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
      },
      {
        id: "code-switch",
        audio: "sample.pcm",
        packet_trace: "sample.packets.json",
        reference: "今日は안녕",
        language: "ja",
        tags: ["clean", "code-switch"],
        key_terms: [],
        expected_languages: ["ja", "ko"],
        expected_segments: 2,
        translation_terms: [],
      },
    ],
  } as const;
}

let datasetSequence = 0;

function writeDataset(pair: "ja-ko" | "ja-en" = "ja-ko"): string {
  const directory = path.join(temporaryDirectory, `dataset-${String(datasetSequence)}`);
  datasetSequence += 1;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const audio = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const audioPath = path.join(directory, "sample.pcm");
  const packetTracePath = path.join(directory, "sample.packets.json");
  writeFileSync(audioPath, audio, { mode: 0o600 });
  writeFileSync(packetTracePath, JSON.stringify({
    version: 1,
    packets: [{ at_ms: 0, byte_length: audio.length }],
  }), { mode: 0o600 });
  const manifestPath = path.join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifestValue(pair)), { mode: 0o600 });
  return manifestPath;
}

void test("Amazon公式SDK境界へ同じPCMと日韓多言語設定を渡し、確定結果だけを観測する", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset());
  const evaluationCase = dataset.cases[0];
  assert.ok(evaluationCase);
  const audioChunks: Buffer[] = [];
  let commandInput: StartStreamTranscriptionCommandInput | undefined;
  const client: AmazonTranscribeStreamingSender = {
    async send(command) {
      commandInput = command.input;
      const audioStream = command.input.AudioStream;
      assert.ok(audioStream);
      for await (const event of audioStream) {
        if (event.AudioEvent?.AudioChunk) {
          audioChunks.push(Buffer.from(event.AudioEvent.AudioChunk));
        }
      }
      return {
        TranscriptResultStream: (async function* () {
          await Promise.resolve();
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [{
                  IsPartial: true,
                  LanguageCode: "ja-JP",
                  Alternatives: [{ Transcript: "ヴァロ" }],
                }],
              },
            },
          };
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [{
                  IsPartial: false,
                  LanguageCode: "ja-JP",
                  Alternatives: [{ Transcript: "ヴァロラント" }],
                }],
              },
            },
          };
        })(),
      };
    },
  };

  const result = await runAmazonTranscribeEvaluationCase(evaluationCase, 1, {
    client,
    timeoutMs: 1_000,
  });

  assert.ok(commandInput);
  assert.equal(commandInput.MediaEncoding, "pcm");
  assert.equal(commandInput.MediaSampleRateHertz, 48_000);
  assert.equal(commandInput.IdentifyMultipleLanguages, true);
  assert.equal(commandInput.LanguageOptions, "ja-JP,ko-KR");
  assert.deepEqual(Buffer.concat(audioChunks), Buffer.concat(
    evaluationCase.packets.map((packet) => packet.audio),
  ));
  assert.equal(result.profile, "amazon_transcribe");
  assert.equal(result.transcript, "ヴァロラント");
  assert.deepEqual(result.segments, ["ヴァロラント"]);
  assert.deepEqual(result.recognized_languages, ["ja"]);
  assert.deepEqual(result.finalizations.map((entry) => entry.reason), ["provider_final"]);
  assert.ok(result.finalizations[0]?.latency_ms !== undefined);
  assert.equal(result.decoded_packet_count, evaluationCase.packets.length);
  assert.equal(result.dropped_packet_count, evaluationCase.droppedPacketCount);
});

void test("Amazon評価timeoutは結果iteratorを閉じて背景処理を止める", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset());
  const evaluationCase = dataset.cases[0];
  assert.ok(evaluationCase);
  let resultEventCount = 0;
  let resultStreamClosed = false;
  const client: AmazonTranscribeStreamingSender = {
    async send(command) {
      const audioStream = command.input.AudioStream;
      assert.ok(audioStream);
      for await (const event of audioStream) assert.ok(event.AudioEvent);
      return {
        TranscriptResultStream: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await delay(5);
                resultEventCount += 1;
                if (resultEventCount >= 20) return { done: true, value: undefined };
                return {
                  done: false,
                  value: {
                    TranscriptEvent: {
                      Transcript: {
                        Results: [{
                          IsPartial: true,
                          LanguageCode: "ja-JP",
                          Alternatives: [{ Transcript: "途中" }],
                        }],
                      },
                    },
                  },
                };
              },
              async return() {
                await Promise.resolve();
                resultStreamClosed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    },
  };

  await assert.rejects(
    runAmazonTranscribeEvaluationCase(evaluationCase, 1, { client, timeoutMs: 15 }),
    /timeout/u,
  );
  const eventCountAtTimeout = resultEventCount;
  await delay(30);
  assert.equal(resultStreamClosed, true);
  assert.ok(resultEventCount <= eventCountAtTimeout + 1);
});

void test("Amazon評価timeoutは未解決のnextを待つ結果iteratorも閉じる", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset());
  const evaluationCase = dataset.cases[0];
  assert.ok(evaluationCase);
  let nextStarted = false;
  let resultStreamClosed = false;
  const client: AmazonTranscribeStreamingSender = {
    async send(command) {
      const audioStream = command.input.AudioStream;
      assert.ok(audioStream);
      for await (const event of audioStream) assert.ok(event.AudioEvent);
      return {
        TranscriptResultStream: {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<never>> {
                nextStarted = true;
                return await new Promise<IteratorResult<never>>(() => undefined);
              },
              async return() {
                await Promise.resolve();
                resultStreamClosed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    },
  };

  await assert.rejects(
    runAmazonTranscribeEvaluationCase(evaluationCase, 1, { client, timeoutMs: 15 }),
    /timeout/u,
  );
  assert.equal(nextStarted, true);
  assert.equal(resultStreamClosed, true);
});

void test("provider比較は既存のCER・固有語・言語切替・分割・p95規則で採点する", () => {
  const manifest = parseSttEvaluationManifest(JSON.stringify(manifestValue()));
  const observations = parseSttEvaluationObservations(JSON.stringify({
    version: 1,
    experiment: "provider_comparison",
    provider_environment: {
      amazon_transcribe: { region: "us-west-2" },
    },
    results: [
      {
        trial: 1,
        case_id: "ja-term",
        profile: "baseline",
        transcript: "バロラント",
        segments: ["バロ", "ラント"],
        recognized_languages: ["ja"],
        finalizations: [{
          kind: "finalized",
          reason: "speaking_end",
          latency_ms: 300,
          has_text: true,
        }],
        cpu_percent: 4,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        trial: 1,
        case_id: "code-switch",
        profile: "baseline",
        transcript: "今日は",
        segments: ["今日は"],
        recognized_languages: ["ja"],
        finalizations: [{
          kind: "finalized",
          reason: "speaking_end",
          latency_ms: 350,
          has_text: true,
        }],
        cpu_percent: 4,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.baseline,
      },
      {
        trial: 1,
        case_id: "ja-term",
        profile: "amazon_transcribe",
        transcript: "ヴァロラント",
        segments: ["ヴァロラント"],
        recognized_languages: ["ja"],
        finalizations: [{
          kind: "finalized",
          reason: "provider_final",
          latency_ms: 320,
          has_text: true,
        }],
        cpu_percent: 5,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.amazon_transcribe,
      },
      {
        trial: 1,
        case_id: "code-switch",
        profile: "amazon_transcribe",
        transcript: "今日は안녕",
        segments: ["今日は", "안녕"],
        recognized_languages: ["ja", "ko"],
        finalizations: [{
          kind: "finalized",
          reason: "provider_final",
          latency_ms: 360,
          has_text: true,
        }],
        cpu_percent: 5,
        decoded_packet_count: 1,
        dropped_packet_count: 0,
        configuration: sttEvaluationProfileConfigurations.amazon_transcribe,
      },
    ],
  }));

  const report = createSttEvaluationReport(manifest, observations, new Date(0));

  const providerEnvironment = report.provider_environment;
  const amazonProfile = report.profiles.amazon_transcribe;
  const amazonComparison = report.comparisons.amazon_transcribe;
  assert.ok(providerEnvironment);
  assert.ok(amazonProfile);
  assert.ok(amazonComparison);
  assert.equal(report.experiment, "provider_comparison");
  assert.equal(providerEnvironment.amazon_transcribe.region, "us-west-2");
  assert.equal(amazonProfile.cer, 0);
  assert.equal(amazonProfile.key_term_recall, 1);
  assert.equal(amazonProfile.language_switch_recall, 1);
  assert.equal(amazonProfile.unnatural_split_count, 0);
  assert.equal(amazonProfile.latency_ms.p95, 360);
  assert.equal(amazonComparison.gates.semantic_endpoint, "not_evaluated");
  assert.equal(amazonComparison.transcript_coverage_change, 0);
  assert.equal(amazonComparison.gates.transcript_coverage, "pass");

  const invalidAmazonReason = structuredClone(observations);
  const invalidAmazonResult = invalidAmazonReason.results.find((result) => (
    result.profile === "amazon_transcribe"
  ));
  assert.ok(invalidAmazonResult);
  const invalidAmazonFinalization = invalidAmazonResult.finalizations[0];
  assert.ok(invalidAmazonFinalization);
  invalidAmazonFinalization.reason = "speaking_end";
  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify(invalidAmazonReason)),
    /amazon_transcribe.*provider_final/u,
  );

  const invalidSonioxReason = structuredClone(observations);
  const invalidSonioxResult = invalidSonioxReason.results.find((result) => (
    result.profile === "baseline"
  ));
  assert.ok(invalidSonioxResult);
  const invalidSonioxFinalization = invalidSonioxResult.finalizations[0];
  assert.ok(invalidSonioxFinalization);
  invalidSonioxFinalization.reason = "provider_final";
  assert.throws(
    () => parseSttEvaluationObservations(JSON.stringify(invalidSonioxReason)),
    /baseline.*provider_final/u,
  );

  const lateTranscriptObservations = structuredClone(observations);
  for (const result of lateTranscriptObservations.results) {
    if (result.profile !== "baseline") continue;
    const finalization = result.finalizations[0];
    assert.ok(finalization);
    finalization.has_text = false;
  }
  const lateTranscriptReport = createSttEvaluationReport(
    manifest,
    lateTranscriptObservations,
  );
  const lateTranscriptComparison = lateTranscriptReport.comparisons.amazon_transcribe;
  assert.ok(lateTranscriptComparison);
  assert.equal(lateTranscriptComparison.baseline_transcript_coverage, 1);
  assert.equal(lateTranscriptComparison.transcript_coverage_change, 0);

  const incompleteObservations = structuredClone(observations);
  const incompleteResult = incompleteObservations.results.find((result) => (
    result.profile === "amazon_transcribe" && result.case_id === "code-switch"
  ));
  assert.ok(incompleteResult);
  incompleteResult.transcript = "";
  incompleteResult.segments = [];
  incompleteResult.recognized_languages = [];
  const incompleteFinalization = incompleteResult.finalizations[0];
  assert.ok(incompleteFinalization);
  incompleteFinalization.has_text = false;
  const incompleteReport = createSttEvaluationReport(manifest, incompleteObservations);
  const incompleteComparison = incompleteReport.comparisons.amazon_transcribe;
  assert.ok(incompleteComparison);
  assert.equal(
    incompleteComparison.transcript_coverage_change,
    -0.5,
  );
  assert.equal(
    incompleteComparison.gates.transcript_coverage,
    "fail",
  );
});

void test("日韓以外のmanifestはprovider接続前に拒否する", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset("ja-en"));
  let amazonSendCount = 0;
  const amazonClient: AmazonTranscribeStreamingSender = {
    async send() {
      await Promise.resolve();
      amazonSendCount += 1;
      throw new Error("Amazonへ接続してはいけません");
    },
  };

  await assert.rejects(
    runSttProviderComparisonDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl: "ws://127.0.0.1:9",
      amazonClient,
      amazonRegion: "us-west-2",
    }),
    /ja-ko|日本語.*韓国語/u,
  );
  assert.equal(amazonSendCount, 0);
});

void test("同じcaseのSonioxとAmazonを試行ごとに逆順で実行する", async () => {
  const dataset = await loadSttEvaluationDataset(writeDataset());
  const amazonClient: AmazonTranscribeStreamingSender = {
    async send(command) {
      const audioStream = command.input.AudioStream;
      assert.ok(audioStream);
      for await (const event of audioStream) assert.ok(event.AudioEvent);
      return {
        TranscriptResultStream: (async function* () {
          await Promise.resolve();
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [{
                  IsPartial: false,
                  LanguageCode: "ja-JP",
                  Alternatives: [{ Transcript: "ヴァロラント" }],
                }],
              },
            },
          };
        })(),
      };
    },
  };

  await withSonioxServer(async (sttWebSocketUrl) => {
    const observations = await runSttProviderComparisonDataset(dataset, {
      apiKey: "do-not-leak-api-key",
      model: "stt-rt-v5",
      sttWebSocketUrl,
      amazonClient,
      amazonRegion: "us-west-2",
      trials: 2,
      boundaryTimeoutMs: 1_000,
      finishTimeoutMs: 1_000,
      amazonTimeoutMs: 1_000,
    });

    assert.deepEqual(observations.provider_environment, {
      amazon_transcribe: { region: "us-west-2" },
    });
    assert.deepEqual(observations.results.map((result) => result.profile), [
      "baseline",
      "amazon_transcribe",
      "amazon_transcribe",
      "baseline",
      "amazon_transcribe",
      "baseline",
      "baseline",
      "amazon_transcribe",
    ]);
    assert.deepEqual(observations.results.map((result) => result.trial), [
      1, 1, 1, 1, 2, 2, 2, 2,
    ]);
    assert.equal(
      parseSttEvaluationObservations(JSON.stringify(observations)).results.length,
      8,
    );
  });
});
