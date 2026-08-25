import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getSonioxRegionEndpoints, type SonioxRegion } from "./config.js";
import {
  assertSttEvaluationDatasetEvidenceMatches,
  createSttEvaluationDatasetEvidence,
  loadSttEvaluationDataset,
  type LoadedSttEvaluationDataset,
} from "./evaluation/stt-evaluation-files.js";
import {
  runSttEndpointOnlyProbe,
  runSttEvaluationDataset,
} from "./evaluation/stt-evaluation-runner.js";
import {
  createSttEvaluationReport,
  parseSttEvaluationExperiment,
  parseSttEvaluationObservations,
  sttEvaluationExperimentProfileMappings,
  type SttEvaluationExperiment,
  type SttEvaluationProfile,
} from "./evaluation/stt-evaluation.js";

const usage = `使用方法:
  pnpm stt:evaluate run --manifest <manifest.json> --observations-output <observations.json> --output <report.json> [--experiment <context_endpoint|endpoint_timing|context_endpoint_400|endpoint_latency_level|recognition_terms|recognition_source_terms>] [--profiles <comma-separated>] [--stt-websocket-url <wss://...>] [--trials <1-10>]
  pnpm stt:evaluate probe-endpoint-only --manifest <manifest.json> --required-case <case-id> --output <summary.json> [--stt-websocket-url <wss://...>] [--trials 3] [--boundary-timeout-ms <milliseconds>]
  pnpm stt:evaluate score --manifest <manifest.json> --observations <observations.json> --output <report.json>

評価音声、packet trace、本文入り観測結果はGit管理外の.data/stt-eval/へ置いてください。`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readObservations(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`STT評価観測結果「${filePath}」を読み込めません`, { cause: error });
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    closed = true;
    await rename(temporaryPath, filePath);
  } finally {
    if (!closed) await file.close();
    await unlinkIfExists(temporaryPath);
  }
}

async function resolveSafeOutputPaths(
  protectedPaths: ReadonlySet<string>,
  outputPaths: readonly string[],
): Promise<string[]> {
  const canonicalProtectedPaths = new Set(await Promise.all(
    [...protectedPaths].map((protectedPath) => realpath(protectedPath)),
  ));
  const canonicalOutputPaths: string[] = [];
  for (const outputPath of outputPaths) {
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(path.dirname(outputPath));
    const canonicalOutputPath = path.join(canonicalParent, path.basename(outputPath));
    try {
      const outputStatus = await lstat(canonicalOutputPath);
      if (outputStatus.isSymbolicLink()) {
        throw new Error(`評価の出力path「${outputPath}」にsymbolic linkは指定できません`);
      }
      if (outputStatus.isDirectory()) {
        throw new Error(`評価の出力path「${outputPath}」にdirectoryは指定できません`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (canonicalProtectedPaths.has(canonicalOutputPath)) {
      throw new Error("評価の出力にはmanifest、PCM、packet trace、観測入力と異なるpathを指定してください");
    }
    canonicalOutputPaths.push(canonicalOutputPath);
  }
  if (new Set(canonicalOutputPaths).size !== canonicalOutputPaths.length) {
    throw new Error("評価の出力pathは相互に異なるpathを指定してください");
  }
  return canonicalOutputPaths;
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

async function assertOwnerOnlyDirectoryChain(
  privateRoot: string,
  directoryPath: string,
): Promise<void> {
  let currentPath = directoryPath;
  while (isWithinPath(privateRoot, currentPath)) {
    const status = await lstat(currentPath);
    if (!status.isDirectory() || (status.mode & 0o077) !== 0) {
      throw new Error(
        `STT評価のprivate directory「${currentPath}」は所有者だけが利用できる0700にしてください`,
      );
    }
    if (currentPath === privateRoot) return;
    currentPath = path.dirname(currentPath);
  }
}

async function assertPrivateRepositoryFiles(
  files: readonly { filePath: string; label: string }[],
): Promise<void> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const privateRoot = path.join(canonicalRepositoryRoot, ".data", "stt-eval");
  for (const file of files) {
    const canonicalFilePath = await realpath(file.filePath);
    if (!isWithinPath(canonicalRepositoryRoot, canonicalFilePath)) continue;
    if (!isWithinPath(privateRoot, canonicalFilePath)) {
      throw new Error(
        `${file.label}はリポジトリ外または.data/stt-eval/配下へ置いてください`,
      );
    }
    await assertOwnerOnlyDirectoryChain(privateRoot, path.dirname(canonicalFilePath));
    const status = await lstat(canonicalFilePath);
    if (!status.isFile() || (status.mode & 0o077) !== 0) {
      throw new Error(
        `${file.label}「${canonicalFilePath}」は所有者だけが読み書きできる0600にしてください`,
      );
    }
  }
}

async function assertPrivateDatasetPaths(dataset: LoadedSttEvaluationDataset): Promise<void> {
  await assertPrivateRepositoryFiles([
    { filePath: dataset.manifestPath, label: "STT評価manifest" },
    ...dataset.cases.flatMap((evaluationCase) => [
      {
        filePath: evaluationCase.audioPath,
        label: `case「${evaluationCase.definition.id}」のPCM`,
      },
      {
        filePath: evaluationCase.packetTracePath,
        label: `case「${evaluationCase.definition.id}」のpacket trace`,
      },
    ]),
  ]);
}

async function assertPrivateObservationsPath(observationsPath: string): Promise<void> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  if (!isWithinPath(canonicalRepositoryRoot, observationsPath)) return;
  const privateOutputRoot = path.join(canonicalRepositoryRoot, ".data", "stt-eval");
  if (!isWithinPath(privateOutputRoot, observationsPath)) {
    throw new Error(
      "本文を含むobservations-outputはリポジトリ外または.data/stt-eval/配下を指定してください",
    );
  }
  await assertOwnerOnlyDirectoryChain(privateOutputRoot, path.dirname(observationsPath));
}

function sonioxSttWebSocketUrl(override: string | undefined): string {
  if (override) return override;
  const region = process.env.SONIOX_REGION;
  if (region !== "us" && region !== "eu" && region !== "jp") {
    throw new Error("SONIOX_REGIONにはus、eu、jpのいずれかを指定してください");
  }
  return getSonioxRegionEndpoints(region satisfies SonioxRegion).sttWebSocketUrl;
}

function parseProfileSelection(
  value: string | undefined,
  experiment: SttEvaluationExperiment,
): SttEvaluationProfile[] | undefined {
  if (value === undefined) return undefined;
  const profiles = value.split(",").map((profile) => profile.trim());
  if (profiles.length === 0 || profiles.some((profile) => profile.length === 0)) {
    throw new Error("STT評価profilesはcomma区切りで1件以上指定してください");
  }
  const allowedProfiles = new Set<string>(
    Object.values(sttEvaluationExperimentProfileMappings[experiment]),
  );
  const invalidProfile = profiles.find((profile) => !allowedProfiles.has(profile));
  if (invalidProfile) {
    throw new Error(`experiment「${experiment}」にprofile「${invalidProfile}」は含まれません`);
  }
  if (profiles.includes("endpoint_only_1000")) {
    throw new Error(
      "endpoint_only_1000はprobe-endpoint-onlyコマンドで必須caseだけを評価してください",
    );
  }
  if (!profiles.includes("baseline")) {
    throw new Error("STT評価profilesにはbaselineを含めてください");
  }
  return profiles as SttEvaluationProfile[];
}

async function run(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      manifest: { type: "string" },
      "observations-output": { type: "string" },
      output: { type: "string" },
      experiment: { type: "string" },
      profiles: { type: "string" },
      "stt-websocket-url": { type: "string" },
      trials: { type: "string" },
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
  await assertPrivateDatasetPaths(dataset);
  const protectedPaths = new Set([
    dataset.manifestPath,
    ...dataset.cases.flatMap((evaluationCase) => [
      evaluationCase.audioPath,
      evaluationCase.packetTracePath,
    ]),
  ]);
  const [resolvedObservationsOutput, resolvedOutputPath] = await resolveSafeOutputPaths(
    protectedPaths,
    [path.resolve(observationsOutput), path.resolve(outputPath)],
  );
  if (!resolvedObservationsOutput || !resolvedOutputPath) {
    throw new Error("評価の出力pathを解決できませんでした");
  }
  await assertPrivateObservationsPath(resolvedObservationsOutput);

  const experiment = parseSttEvaluationExperiment(
    parsed.values.experiment ?? "context_endpoint",
  );
  const profiles = parseProfileSelection(parsed.values.profiles, experiment);
  const observations = await runSttEvaluationDataset(dataset, {
    apiKey,
    model,
    sttWebSocketUrl: sonioxSttWebSocketUrl(parsed.values["stt-websocket-url"]),
    experiment,
    ...(profiles === undefined ? {} : { profiles }),
    trials: parsed.values.trials === undefined ? 1 : Number(parsed.values.trials),
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
    experiment: report.experiment,
    profiles: Object.keys(report.profiles),
    case_count: dataset.cases.length,
    trial_count: report.profiles.baseline?.trial_count,
  }));
}

async function probeEndpointOnly(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      manifest: { type: "string" },
      "required-case": { type: "string" },
      output: { type: "string" },
      "stt-websocket-url": { type: "string" },
      trials: { type: "string" },
      "boundary-timeout-ms": { type: "string" },
    },
  });
  const manifestPath = parsed.values.manifest;
  const requiredCaseId = parsed.values["required-case"];
  const outputPath = parsed.values.output;
  if (!manifestPath || !requiredCaseId || !outputPath) throw new Error(usage);
  const apiKey = process.env.SONIOX_API_KEY?.trim();
  const model = process.env.SONIOX_STT_MODEL?.trim();
  if (!apiKey) throw new Error("SONIOX_API_KEYが設定されていません");
  if (!model) throw new Error("SONIOX_STT_MODELが設定されていません");

  const dataset = await loadSttEvaluationDataset(manifestPath);
  await assertPrivateDatasetPaths(dataset);
  const protectedPaths = new Set([
    dataset.manifestPath,
    ...dataset.cases.flatMap((evaluationCase) => [
      evaluationCase.audioPath,
      evaluationCase.packetTracePath,
    ]),
  ]);
  const [resolvedOutputPath] = await resolveSafeOutputPaths(
    protectedPaths,
    [path.resolve(outputPath)],
  );
  if (!resolvedOutputPath) throw new Error("評価の出力pathを解決できませんでした");

  const summary = await runSttEndpointOnlyProbe(dataset, {
    apiKey,
    model,
    sttWebSocketUrl: sonioxSttWebSocketUrl(parsed.values["stt-websocket-url"]),
    requiredCaseId,
    trials: parsed.values.trials === undefined ? 3 : Number(parsed.values.trials),
    boundaryTimeoutMs: parsed.values["boundary-timeout-ms"] === undefined
      ? 10_000
      : Number(parsed.values["boundary-timeout-ms"]),
  });
  await writePrivateJson(resolvedOutputPath, summary);
  console.log(JSON.stringify({
    report: resolvedOutputPath,
    experiment: summary.experiment,
    profile: summary.profile,
    required_case: summary.dataset.case.case_id,
    trial_count: summary.trials.length,
    outcome: summary.outcome,
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
  const requestedOutputPath = path.resolve(outputPath);
  const protectedPaths = new Set<string>([
    path.resolve(manifestPath),
    path.resolve(observationsPath),
  ]);

  const dataset = await loadSttEvaluationDataset(manifestPath);
  await assertPrivateDatasetPaths(dataset);
  await assertPrivateRepositoryFiles([{
    filePath: path.resolve(observationsPath),
    label: "STT評価observations",
  }]);
  for (const evaluationCase of dataset.cases) {
    protectedPaths.add(evaluationCase.audioPath);
    protectedPaths.add(evaluationCase.packetTracePath);
  }
  const [resolvedOutputPath] = await resolveSafeOutputPaths(protectedPaths, [requestedOutputPath]);
  if (!resolvedOutputPath) throw new Error("評価の出力pathを解決できませんでした");
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
  if (command === "probe-endpoint-only") {
    await probeEndpointOnly(args);
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
