import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sttEvaluationRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export async function assertOwnerOnlyDirectoryChain(
  privateRoot: string,
  directoryPath: string,
): Promise<void> {
  let currentPath = directoryPath;
  while (isWithinPath(privateRoot, currentPath)) {
    const status = await lstat(currentPath);
    if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
      throw new Error(
        `STT評価のprivate directory「${currentPath}」は所有者だけが利用できる0700にしてください`,
      );
    }
    if (currentPath === privateRoot) return;
    currentPath = path.dirname(currentPath);
  }
}

export async function assertPrivateSttEvaluationFiles(
  files: readonly { filePath: string; label: string }[],
): Promise<void> {
  const canonicalRepositoryRoot = await realpath(sttEvaluationRepositoryRoot);
  const privateRoot = path.join(canonicalRepositoryRoot, ".data", "stt-eval");
  for (const file of files) {
    const requestedPath = path.resolve(file.filePath);
    const requestedParent = path.dirname(requestedPath);
    const canonicalRequestedParent = await realpath(requestedParent);
    if (canonicalRequestedParent !== requestedParent) {
      throw new Error(`${file.label}の親directoryにsymbolic linkは指定できません`);
    }
    const requestedStatus = await lstat(requestedPath);
    if (
      !requestedStatus.isFile() ||
      requestedStatus.isSymbolicLink() ||
      (requestedStatus.mode & 0o077) !== 0
    ) {
      throw new Error(
        `${file.label}「${requestedPath}」は所有者だけが読み書きできる通常fileの0600にしてください`,
      );
    }
    const canonicalFilePath = await realpath(requestedPath);
    const isRepositoryFile = isWithinPath(canonicalRepositoryRoot, canonicalFilePath);
    if (isRepositoryFile && !isWithinPath(privateRoot, canonicalFilePath)) {
      throw new Error(
        `${file.label}はリポジトリ外または.data/stt-eval/配下へ置いてください`,
      );
    }
    const privateDirectoryRoot = isRepositoryFile
      ? privateRoot
      : path.dirname(canonicalFilePath);
    await assertOwnerOnlyDirectoryChain(
      privateDirectoryRoot,
      path.dirname(canonicalFilePath),
    );
  }
}
