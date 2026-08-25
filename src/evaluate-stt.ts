import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { getSonioxRegionEndpoints, type SonioxRegion } from "./config.js";
import {
  assertSttEvaluationDatasetEvidenceMatches,
  createSttEvaluationDatasetEvidence,
  loadSttEvaluationDataset,
} from "./evaluation/stt-evaluation-files.js";
import { runSttEvaluationDataset } from "./evaluation/stt-evaluation-runner.js";
import {
  createSttEvaluationReport,
  parseSttEvaluationObservations,
} from "./evaluation/stt-evaluation.js";

const usage = `使用方法:
  pnpm stt:evaluate run --manifest <manifest.json> --observations-output <observations.json> --output <report.json> [--stt-websocket-url <wss://...>]
  pnpm stt:evaluate score --manifest <manifest.json> --observations <observations.json> --output <report.json>

評価音声、packet trace、観測結果、出力はGit管理外の.data/stt-eval/へ置いてください。`;

async function readObservations(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`STT評価観測結果「${filePath}」を読み込めません`, { cause: error });
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function assertOutputPathsAreSafe(
  protectedPaths: ReadonlySet<string>,
  outputPaths: readonly string[],
): void {
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new Error("評価の出力pathは相互に異なるpathを指定してください");
  }
  for (const outputPath of outputPaths) {
    if (protectedPaths.has(outputPath)) {
      throw new Error("評価の出力にはmanifest、PCM、packet trace、観測入力と異なるpathを指定してください");
    }
  }
}

function sonioxSttWebSocketUrl(override: string | undefined): string {
  if (override) return override;
  const region = process.env.SONIOX_REGION;
  if (region !== "us" && region !== "eu" && region !== "jp") {
    throw new Error("SONIOX_REGIONにはus、eu、jpのいずれかを指定してください");
  }
  return getSonioxRegionEndpoints(region satisfies SonioxRegion).sttWebSocketUrl;
}

async function run(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      manifest: { type: "string" },
      "observations-output": { type: "string" },
      output: { type: "string" },
      "stt-websocket-url": { type: "string" },
    },
  });
  const manifestPath = parsed.values.manifest;
  const observationsOutput = parsed.values["observations-output"];
  const outputPath = parsed.values.output;
  if (!manifestPath || !observationsOutput || !outputPath) throw new Error(usage);
  const apiKey = process.env.SONIOX_API_KEY?.trim();
  const model = process.env.SONIOX_STT_MODEL?.trim();
  if (!apiKey) throw new Error("SONIOX_API_KEYが設定されていません");
  if (!model) throw new Error("SONIOX_STT_MODELが設定されていません");

  const dataset = await loadSttEvaluationDataset(manifestPath);
  const protectedPaths = new Set([
    dataset.manifestPath,
    ...dataset.cases.flatMap((evaluationCase) => [
      evaluationCase.audioPath,
      evaluationCase.packetTracePath,
    ]),
  ]);
  const resolvedObservationsOutput = path.resolve(observationsOutput);
  const resolvedOutputPath = path.resolve(outputPath);
  assertOutputPathsAreSafe(protectedPaths, [resolvedObservationsOutput, resolvedOutputPath]);

  const observations = await runSttEvaluationDataset(dataset, {
    apiKey,
    model,
    sttWebSocketUrl: sonioxSttWebSocketUrl(parsed.values["stt-websocket-url"]),
  });
  const report = {
    ...createSttEvaluationReport(dataset.manifest, observations),
    dataset: observations.dataset,
  };
  await writePrivateJson(resolvedObservationsOutput, observations);
  await writePrivateJson(resolvedOutputPath, report);
  console.log(JSON.stringify({
    observations: resolvedObservationsOutput,
    report: resolvedOutputPath,
    profiles: Object.keys(report.profiles),
    case_count: dataset.cases.length,
  }));
}

async function score(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      manifest: { type: "string" },
      observations: { type: "string" },
      output: { type: "string" },
    },
  });
  const manifestPath = parsed.values.manifest;
  const observationsPath = parsed.values.observations;
  const outputPath = parsed.values.output;
  if (!manifestPath || !observationsPath || !outputPath) throw new Error(usage);
  const resolvedOutputPath = path.resolve(outputPath);
  const protectedPaths = new Set<string>([
    path.resolve(manifestPath),
    path.resolve(observationsPath),
  ]);

  const dataset = await loadSttEvaluationDataset(manifestPath);
  for (const evaluationCase of dataset.cases) {
    protectedPaths.add(evaluationCase.audioPath);
    protectedPaths.add(evaluationCase.packetTracePath);
  }
  assertOutputPathsAreSafe(protectedPaths, [resolvedOutputPath]);
  const observations = parseSttEvaluationObservations(
    await readObservations(path.resolve(observationsPath)),
  );
  assertSttEvaluationDatasetEvidenceMatches(dataset, observations);
  const report = {
    ...createSttEvaluationReport(dataset.manifest, observations),
    dataset: createSttEvaluationDatasetEvidence(dataset),
  };
  await writePrivateJson(resolvedOutputPath, report);
  console.log(JSON.stringify({
    report: resolvedOutputPath,
    profiles: Object.keys(report.profiles),
    case_count: dataset.cases.length,
  }));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") {
    await run(args);
    return;
  }
  if (command === "score") {
    await score(args);
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  throw new Error(usage);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "STT評価に失敗しました");
  process.exitCode = 1;
}
