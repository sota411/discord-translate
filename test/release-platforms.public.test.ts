import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

void test("PR検証とGHCR公開は同じamd64・arm64 imageをbuildする", async () => {
  for (const workflowPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
  ]) {
    const workflow = await readRepositoryFile(workflowPath);
    const qemuIndex = workflow.indexOf("docker/setup-qemu-action@");
    const buildxIndex = workflow.indexOf("docker/setup-buildx-action@");

    assert.match(
      workflow,
      /uses: docker\/setup-qemu-action@[0-9a-f]{40}(?:\s+#.*)?/,
      `${workflowPath}はQEMU actionをcommit SHAで固定する`,
    );
    assert.ok(
      qemuIndex >= 0 && qemuIndex < buildxIndex,
      `${workflowPath}はBuildxより先にQEMUを準備する`,
    );
    assert.match(
      workflow,
      /platforms:\s*linux\/amd64,linux\/arm64/,
      `${workflowPath}はamd64とarm64を同じ定義からbuildする`,
    );
  }
});

void test("Pi用ComposeはARM64と限定seccomp profileを明示しportを公開しない", async () => {
  const compose = await readRepositoryFile("compose.pi.yaml");

  assert.match(compose, /^\s*platform:\s*linux\/arm64\s*$/m);
  assert.match(
    compose,
    /^\s*-\s*seccomp=\$\{BOT_SECCOMP_PROFILE:\?[^}]+\}\s*$/m,
  );
  assert.doesNotMatch(compose, /unconfined/);
  assert.doesNotMatch(compose, /^\s*ports:\s*$/m);
});

void test("Docker imageは対象platformでnative moduleを読み込んでから完成する", async () => {
  const dockerfile = await readRepositoryFile("Dockerfile");

  assert.match(dockerfile, /^COPY scripts\/smoke-runtime\.mjs \.\/scripts\/$/m);
  assert.match(
    dockerfile,
    /^RUN pnpm build && pnpm smoke:runtime && pnpm prune --prod$/m,
  );
  assert.match(
    dockerfile,
    /^COPY --from=build --chown=node:node \/app\/scripts \.\/scripts$/m,
  );
});

void test("Pi用seccomp profileはDocker 28.5.2公式profileから再現する", async () => {
  const script = await readRepositoryFile(
    "scripts/prepare-pi-seccomp-profile.sh",
  );

  assert.match(
    script,
    /moby\/moby\/v28\.5\.2\/vendor\/github\.com\/moby\/profiles\/seccomp\/default\.json/,
  );
  assert.match(
    script,
    /01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28/,
  );
  assert.match(
    script,
    /f16b3056cacd6e9f22a959ac827e20d258ffdd5e804e67ed68dae27c297c9983/,
  );
  assert.match(script, /python3/);
  assert.doesNotMatch(script, /\bjq\b/);
  assert.match(script, /SCMP_ARCH_AARCH64/);
  assert.doesNotMatch(script, /seccomp[=:]unconfined/);
});

void test("SQLite移行手順はbackupと復帰先containerを追跡可能にする", async () => {
  const [operations, gitignore, dockerignore] = await Promise.all([
    readRepositoryFile("docs/operations.md"),
    readRepositoryFile(".gitignore"),
    readRepositoryFile(".dockerignore"),
  ]);
  const migrationSection = operations
    .split("## PCからPiへの初回切替ではSQLiteを停止中に移す")[1]
    ?.split("\n## ")[0];

  assert.ok(migrationSection, "SQLite移行手順が存在する");
  assert.match(migrationSection, /\.data\/migration\/source-container-id/);
  assert.match(migrationSection, /sha256sum --check/);
  assert.match(migrationSection, /docker start "\$source_container"/);
  assert.match(migrationSection, /docker run --rm --pull never/);
  assert.match(
    migrationSection,
    /docker compose[^\n]*pull bot &&[\s\S]*?create --no-recreate --no-build --pull never bot/,
    "対象imageを起動せずにpullしてから復元先を作る",
  );
  assert.match(
    migrationSection,
    /ssh raspberrypi '[^\n]+' &&\n\s*scp /,
    "Pi側の転送先を作れなければbackupを転送しない",
  );
  assert.match(
    migrationSection,
    /if ! cd \/home\/sota411\/services\/discord-translate; then[\s\S]*?else[\s\S]*?SQLite data was restored/,
    "Pi側の配備ディレクトリへ移動できなければ復元しない",
  );
  assert.doesNotMatch(migrationSection, /docker compose[^\n]* run --rm/);
  assert.doesNotMatch(migrationSection, /docker compose[^\n]* up [^\n]*bot/);
  assert.match(gitignore, /^\.data\/$/m);
  assert.match(dockerignore, /^\.data$/m);
});

void test("配備と巻き戻しはpull済みimageだけを検査し途中失敗で停止する", async () => {
  const operations = await readRepositoryFile("docs/operations.md");
  const deploySection = operations
    .split("## publish成功後に同じcommitを配備する")[1]
    ?.split("\n## ")[0];
  const rollbackSection = operations
    .split("## 巻き戻しではimageとCompose定義を同じSHAへ戻す")[1]
    ?.split("\n## ")[0];

  assert.ok(deploySection, "配備手順が存在する");
  assert.ok(rollbackSection, "巻き戻し手順が存在する");
  const piDeploySection = deploySection.split("Raspberry Piでは")[1];
  const piRollbackSection = rollbackSection.split("Raspberry Piでは")[1];

  assert.ok(piDeploySection, "自己完結したPi配備手順が存在する");
  assert.ok(piRollbackSection, "自己完結したPi巻き戻し手順が存在する");
  assert.doesNotMatch(
    deploySection,
    /docker compose[^\n]*run[^\n]*smoke-runtime/,
  );
  assert.match(deploySection, /docker compose[^\n]*pull bot &&/);
  assert.match(piDeploySection, /export DEPLOY_SHA=/);
  assert.match(piDeploySection, /git fetch origin &&/);
  assert.match(piDeploySection, /read -r reviewed_deploy_sha &&/);
  assert.match(
    piDeploySection,
    /test "\$reviewed_deploy_sha" = "\$DEPLOY_SHA" &&/,
  );
  assert.match(piDeploySection, /git switch --detach "\$DEPLOY_SHA" &&/);
  assert.ok(
    piDeploySection.includes(
      `test "$(docker image inspect "$BOT_IMAGE" --format '{{.Architecture}}')" = "arm64" &&`,
    ),
    "Pi配備はarm64以外のimageを拒否する",
  );
  assert.match(piDeploySection, /docker run --rm --pull never --platform linux\/arm64/);
  assert.match(piDeploySection, /node scripts\/smoke-runtime\.mjs &&/);
  assert.match(rollbackSection, /docker compose[^\n]*pull bot &&/);
  assert.match(piRollbackSection, /-f compose\.yaml -f compose\.pi\.yaml pull bot &&/);
  assert.match(piRollbackSection, /read -r reviewed_rollback_sha &&/);
  assert.match(
    piRollbackSection,
    /test "\$reviewed_rollback_sha" = "\$ROLLBACK_SHA" &&/,
  );
  assert.ok(
    piRollbackSection.includes(
      `test "$(docker image inspect "$BOT_IMAGE" --format '{{.Architecture}}')" = "arm64" &&`,
    ),
    "Pi巻き戻しはarm64以外のimageを拒否する",
  );
  assert.match(piRollbackSection, /docker run --rm --pull never --platform linux\/arm64/);
  assert.match(piRollbackSection, /node scripts\/smoke-runtime\.mjs &&/);
});

void test("設計文書はPRとpublishのmulti-platform buildを説明する", async () => {
  const design = await readRepositoryFile("docs/design.md");
  const deliverySection = design
    .split("### 配置と終了処理")[1]
    ?.split("\n### ")[0];

  assert.ok(deliverySection, "CI/CD設計が存在する");
  assert.match(deliverySection, /`linux\/amd64`/);
  assert.match(deliverySection, /`linux\/arm64`/);
});
