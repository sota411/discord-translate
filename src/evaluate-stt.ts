import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  createSttEvaluationDatasetEvidence,
  loadSttEvaluationDataset,
} from "./evaluation/stt-evaluation-files.js";
import {
  createSttEvaluationReport,
  parseSttEvaluationObservations,
} from "./evaluation/stt-evaluation.js";

const usage = `使用方法:
  pnpm stt:evaluate -- score --manifest <manifest.json> --observations <observations.json> --output <report.json>

評価音声、packet trace、観測結果、出力はGit管理外の.data/stt-eval/へ置いてください。`;

async function readObservations(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`STT評価観測結果「${filePath}」を読み込めません`, { cause: error });
  }
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
  const protectedPaths = new Set([
    path.resolve(manifestPath),
    path.resolve(observationsPath),
  ]);
  if (protectedPaths.has(resolvedOutputPath)) {
    throw new Error("--outputにはmanifestまたはobservationsと異なるpathを指定してください");
  }

  const dataset = await loadSttEvaluationDataset(manifestPath);
  for (const evaluationCase of dataset.cases) {
    protectedPaths.add(evaluationCase.audioPath);
    protectedPaths.add(evaluationCase.packetTracePath);
  }
  if (protectedPaths.has(resolvedOutputPath)) {
    throw new Error("--outputには評価入力と異なるpathを指定してください");
  }
  const observations = parseSttEvaluationObservations(
    await readObservations(path.resolve(observationsPath)),
  );
  const report = {
    ...createSttEvaluationReport(dataset.manifest, observations),
    dataset: createSttEvaluationDatasetEvidence(dataset),
  };
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    report: resolvedOutputPath,
    profiles: Object.keys(report.profiles),
    case_count: dataset.cases.length,
  }));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
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
