# 配備・巻き戻し手順

この文書は、GHCRへ公開されたBotを配備・監視・巻き戻す運用担当者向けである。初回は「CDは2つのCPU向けimageをGHCRへ公開して止める」「初回だけ配備ホストとGHCR認証を準備する」までを読む。配備、ログ確認、巻き戻しは作業時に該当する節だけを参照する。

## CDは2つのCPU向けimageをGHCRへ公開して止める

Pull RequestではソースとDockerイメージを検証する。`main`へのmerge後は、同じcommitを再検証してから`ghcr.io/sota411/discord-translate`へpushする。

自動化する範囲は、検証済みcommitから配備可能なイメージを公開するところまでである。Raspberry Piへの配備はこの手順に沿って手動で行い、自動deployはまだ追加しない。Pi専用の更新権限、実サービスの機械的な合否判定、失敗時の自動巻き戻しを実機で確立していないためである。

公開対象は`linux/amd64`と`linux/arm64`である。PRとpublishは同じ2 platformをbuildし、Dockerfile内で`better-sqlite3`と`@discordjs/opus`を対象platform向けに読み込む。これにより、native moduleを読み込めないimageはGHCRへ到達しない。

ARM64のbuildにはQEMUを使う。この検査で分かるのはimage単体の起動可能性までであり、DiscordやSonioxとの接続、実ホストのDocker設定までは保証しない。配備後は、実ホストで`application_ready`と実サービスの最小確認を行う。

## SHA tagで配備する版を固定する

| tag | 更新契機と用途 |
|---|---|
| `sha-<40文字のcommit SHA>` | main、version tag、手動公開で作る。通常の配備と巻き戻しに使う |
| `1.2.3` | Gitの`v1.2.3` tagから作るversion |

公開workflowは、どのcommitかが変わる`main`、`1.2`、`latest`などの可変tagを作らない。本番相当の運用では`sha-...`を使う。Docker tag自体は再度pushできるため、厳密に同じimageを固定する必要がある場合は、pull後に`RepoDigests`を記録し、`ghcr.io/sota411/discord-translate@sha256:...`を`BOT_IMAGE`へ指定する。

```bash
docker image inspect "$BOT_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}'
```

## 初回だけ配備ホストとGHCR認証を準備する

配備ホストへDocker Engine、Docker Compose、Gitを用意する。Compose定義もimageと同じcommitへそろえるため、リポジトリをcloneする。

```bash
git clone https://github.com/sota411/discord-translate.git &&
  cd discord-translate &&
  export DEPLOY_SHA="<配備する40文字のcommit SHA>" &&
  git switch --detach "$DEPLOY_SHA" &&
  cp -n .env.example .env.local &&
  chmod 600 .env.local
```

`.env.local`へDiscord Token、Soniox API Key、許可リスト、費用上限などを設定する。詳細は[README](../README.md)を参照する。秘密情報は配備ホストだけに置き、GitHub ActionsやDocker imageへ入れない。

GHCR packageがprivateの場合は、`read:packages`だけを持つpersonal access token（classic）でログインする。public packageを匿名でpullする場合、この操作は不要である。

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u sota411 --password-stdin
```

`GHCR_TOKEN`はホストのSecret管理へ保存する。Git、`.env.local`、コマンド引数へ値を直接書かない。

## 現在のRaspberry PiではARM64用seccomp profileを明示する

現在の配備先は、64-bit ARMカーネル上で32-bit Raspberry Pi OSを動かしている。Docker Engineは`armhf`版の28.5.2で、Botは`linux/arm64`コンテナとして動かす。この組み合わせではDocker既定のseccomp profileがdaemon側の`arm`を選ぶため、ARM64 Node.jsは`SIGSYS`で終了する。

`seccomp=unconfined`は使わない。Docker 28.5.2の公式profileを取得し、対象architectureだけを`SCMP_ARCH_AARCH64`へ固定したprofileを作る。取得元と変換後のSHA-256はスクリプト内で固定している。

```bash
./scripts/prepare-pi-seccomp-profile.sh &&
  export BOT_SECCOMP_PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/discord-translate/seccomp/aarch64-v28.5.2.json" &&
  docker version --format 'server={{.Server.Version}} arch={{.Server.Arch}}' &&
  sha256sum "$BOT_SECCOMP_PROFILE"
```

期待するDocker Serverは`28.5.2/arm`、profileのSHA-256は`f16b3056cacd6e9f22a959ac827e20d258ffdd5e804e67ed68dae27c297c9983`である。profileは[Moby v28.5.2の既定seccomp定義](https://github.com/moby/moby/blob/v28.5.2/vendor/github.com/moby/profiles/seccomp/default.json)から生成する。32-bit Raspberry Pi OSをサポートするDocker Engineはv28が最後であるため、恒久対応は[64-bit Raspberry Pi OSへの移行](https://docs.docker.com/engine/install/raspberry-pi-os/#32-bit-raspberry-pi-os)である。

Piでは、以降の`docker compose`コマンドへ必ずPi用overrideを追加する。

```bash
docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml config -q
```

`compose.pi.yaml`は`linux/arm64`、上記seccomp profile、10 MB×3世代のログrotationだけを追加する。ホストportは公開しない。64-bit OSへ移行して64-bit Docker Engineを導入した後は、このprofileが必要かを再検証し、不要ならPi用overrideから`security_opt`を削除する。

## publish成功後に同じcommitを配備する

1. GitHub Actionsで対象commitの`verify`と`publish`が成功していることを確認する。
2. 配備ホストのCompose定義を対象commitへ合わせる。
3. SHA tagを`BOT_IMAGE`へ設定し、ローカルbuildを禁止して起動する。

次のブロックはRaspberry Pi以外の配備ホストで使う。Piでは実行せず、その次のPi専用ブロックだけを実行する。どちらのブロックも`.env.example`の差分を表示した後に入力待ちになる。別terminalで、既存の秘密値を保持したまま必要な設定を`.env.local`へ反映し、表示された対象SHAを正確に入力する。SHAが一致するまでcheckout、pull、起動へ進まない。

```bash
export CURRENT_DEPLOY_SHA="<現在配備中の40文字のcommit SHA>"
export DEPLOY_SHA="<配備する40文字のcommit SHA>"
export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$DEPLOY_SHA"

if (
  git fetch origin &&
    git diff "$CURRENT_DEPLOY_SHA" "$DEPLOY_SHA" -- .env.example &&
    printf 'Update .env.local if needed, then enter %s to continue: ' "$DEPLOY_SHA" >&2 &&
    read -r reviewed_deploy_sha &&
    test "$reviewed_deploy_sha" = "$DEPLOY_SHA" &&
    git switch --detach "$DEPLOY_SHA" &&
    docker compose --env-file .env.local config -q &&
    docker compose --env-file .env.local pull bot &&
    docker compose --env-file .env.local up --no-build --pull never -d bot &&
    docker compose --env-file .env.local ps &&
    docker compose --env-file .env.local logs --tail=100 bot
); then
  echo "Deployment commands completed"
else
  echo "Deployment stopped after a failed command" >&2
  false
fi
```

Raspberry Piでは、前の汎用ブロックを実行しない。次のブロックだけで対象commitへの切替、profileとPi用overrideの適用、native moduleの実機検査、Botの起動までを行う。

```bash
if export CURRENT_DEPLOY_SHA="<現在配備中の40文字のcommit SHA>" &&
  export DEPLOY_SHA="<配備する40文字のcommit SHA>" &&
  export BOT_SECCOMP_PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/discord-translate/seccomp/aarch64-v28.5.2.json" &&
  export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$DEPLOY_SHA" &&
  git fetch origin &&
  git diff "$CURRENT_DEPLOY_SHA" "$DEPLOY_SHA" -- .env.example &&
  printf 'Update .env.local if needed, then enter %s to continue: ' "$DEPLOY_SHA" >&2 &&
  read -r reviewed_deploy_sha &&
  test "$reviewed_deploy_sha" = "$DEPLOY_SHA" &&
  git switch --detach "$DEPLOY_SHA" &&
  docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml config -q &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml pull bot &&
    test "$(docker image inspect "$BOT_IMAGE" --format '{{.Architecture}}')" = "arm64" &&
    docker image inspect "$BOT_IMAGE" --format 'architecture={{.Architecture}} digest={{range .RepoDigests}}{{println .}}{{end}}' &&
    docker run --rm --pull never --platform linux/arm64 --network none --read-only \
      --security-opt "seccomp=$BOT_SECCOMP_PROFILE" \
      "$BOT_IMAGE" node scripts/smoke-runtime.mjs &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml \
      up --no-build --pull never -d bot &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml ps &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml logs --tail=100 bot; then
  echo "Raspberry Pi deployment commands completed"
else
  echo "Raspberry Pi deployment stopped after a failed command" >&2
  false
fi
```

`architecture=arm64`、`{"sqlite":true,"opus":true}`、`application_ready`の3点がそろうまで、配備元のコンテナとvolumeは削除しない。

`.env.local`を`.env.example`で上書きしない。入力ゲートを通過した後もComposeの設定検査が失敗した場合は、Botを起動せず設定を修正する。

上のコマンドは同じshellで続けて実行する。新しいshellを開いた場合は、`DEPLOY_SHA`と`BOT_IMAGE`を再設定してからComposeを実行する。

ログに`"event":"application_ready"`が出れば起動は完了している。起動に失敗して再起動を繰り返す場合は、先にBotを停止して原因を確認する。

```bash
docker compose --env-file .env.local stop bot &&
  docker compose --env-file .env.local logs --tail=200 bot
```

Slash Commandの定義を変更したreleaseでは、Bot本体の更新とは別に登録する。

```bash
docker compose --env-file .env.local exec bot node dist/register-commands.js
```

Piで登録する場合も、同じコマンドへ`-f compose.yaml -f compose.pi.yaml`を追加する。

## PCからPiへの初回切替ではSQLiteを停止中に移す

二重起動とSQLiteの取りこぼしを避けるため、移行中はBotを停止する。Discordの`/status`で実行中セッションがないことを確認した後、PC側で次を実行する。

```bash
source_container="$(docker compose --env-file .env.local ps -aq bot)"
migration_dir="$PWD/.data/migration"
source_container_id_file="$migration_dir/source-container-id"
backup_file="$migration_dir/discord-translate-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
backup_checksum_file="$backup_file.sha256"

if [ -z "$source_container" ]; then
  echo "Bot container was not found; backup was not started" >&2
  false
elif ! install -d -m 700 "$migration_dir"; then
  echo "Migration directory could not be prepared; Bot was not stopped" >&2
  false
elif ! (
  umask 077
  printf '%s\n' "$source_container" >"$source_container_id_file" &&
    chmod 600 "$source_container_id_file"
); then
  echo "Source container ID could not be recorded; Bot was not stopped" >&2
  false
elif docker compose --env-file .env.local stop bot; then
  if (
    umask 077
    backup_dir="$(mktemp -d)" || exit 1
    trap 'rm -rf -- "$backup_dir"' EXIT
    trap 'exit 1' HUP INT TERM
    backup_name="${backup_file##*/}"
    docker cp "$source_container:/data/." "$backup_dir/" &&
      tar -C "$backup_dir" -czf "$backup_file" . &&
      (
        cd "$migration_dir" &&
          sha256sum "$backup_name" >"$backup_name.sha256"
      ) &&
      chmod 600 "$backup_file" "$backup_checksum_file" &&
      cat "$backup_checksum_file"
  ); then
    echo "Backup created: $backup_file"
  elif docker start "$source_container"; then
    echo "Backup failed; the original PC container was restarted" >&2
    false
  else
    echo "Backup and PC container restart both failed" >&2
    false
  fi
else
  echo "Bot did not stop; backup was not started" >&2
  false
fi
```

バックアップをSSHでPiの配備ディレクトリへ送り、表示されたSHA-256がPC側と一致することを確認する。SQLiteには利用履歴が入るため、公開ストレージやチャットへ置かない。

```bash
ssh raspberrypi 'install -d -m 700 /home/sota411/services/discord-translate/.data/migration' &&
  scp "$backup_file" "$backup_checksum_file" raspberrypi:/home/sota411/services/discord-translate/.data/migration/
```

Pi側では、対象imageをpullした後、停止状態のBotコンテナへデータを復元する。

```bash
if ! cd /home/sota411/services/discord-translate; then
  echo "Pi deployment directory was not found; restore was not started" >&2
  false
else
  export DEPLOY_SHA="<配備する40文字のcommit SHA>"
  export BOT_SECCOMP_PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/discord-translate/seccomp/aarch64-v28.5.2.json"
  export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$DEPLOY_SHA"
  restore_file="/home/sota411/services/discord-translate/.data/migration/<転送したバックアップ名>.tgz"
  restore_checksum_file="$restore_file.sha256"

  if (
    restore_dir="$(mktemp -d)" || exit 1
    trap 'rm -rf -- "$restore_dir"' EXIT
    trap 'exit 1' HUP INT TERM
    chmod 600 "$restore_file" "$restore_checksum_file" &&
      (
        cd "${restore_file%/*}" &&
          sha256sum --check "${restore_checksum_file##*/}"
      ) &&
      tar -C "$restore_dir" -xzf "$restore_file" &&
      docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml pull bot &&
      target_container_before="$(docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml ps -aq bot)" &&
      docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml \
        create --no-recreate --no-build --pull never bot &&
      target_container="$(docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml ps -aq bot)" &&
      test -n "$target_container" &&
      (
        test -z "$target_container_before" ||
          test "$target_container" = "$target_container_before"
      ) &&
      test "$(docker container inspect "$target_container" --format '{{.State.Running}}')" = "false" &&
      docker cp "$restore_dir/." "$target_container:/data/" &&
      data_volume="$(docker container inspect "$target_container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')" &&
      test -n "$data_volume" &&
      docker run --rm --pull never --platform linux/arm64 --network none --read-only \
        --security-opt "seccomp=$BOT_SECCOMP_PROFILE" --user root --entrypoint sh \
        --mount "type=volume,source=$data_volume,target=/data" "$BOT_IMAGE" \
        -c 'chown -R node:node /data && chmod 700 /data && find /data -type f -exec chmod 600 {} +'
  ); then
    echo "SQLite data was restored to the stopped Pi container"
  else
    echo "SQLite restore failed; do not start the Pi Bot" >&2
    false
  fi
fi
```

復元後は前節のPi用起動手順を実行する。`application_ready`まで到達しなければPi側を停止する。その後、PC側で停止前のコンテナそのものを再開する。

```bash
source_container_id_file="$PWD/.data/migration/source-container-id"
source_container="$(cat "$source_container_id_file" 2>/dev/null)"
if [ -z "$source_container" ]; then
  echo "Recorded PC container ID was not found; do not create a replacement with an unverified image" >&2
  false
elif docker container inspect "$source_container" >/dev/null 2>&1; then
  docker start "$source_container"
else
  echo "Recorded PC container no longer exists; restore it from the recorded image before continuing" >&2
  false
fi
```

Piが実際のセッションを受け付けた後は両側のSQLiteが分岐するため、単純にPCへ戻さず、どちらを正本にするかを決めてから復元する。

## 通常の状態確認はComposeから行う

```bash
docker compose --env-file .env.local ps &&
  docker compose --env-file .env.local logs --tail=100 bot &&
  docker compose --env-file .env.local logs --since=30m bot
```

このBotはHTTPのhealth endpointを持たない。現時点の機械的な起動確認はprocess状態と`application_ready`ログであり、実際の音声翻訳はREADMEの「最小確認」で確かめる。

## 巻き戻しではimageとCompose定義を同じSHAへ戻す

直前に正常稼働していたcommit SHAへ、host checkoutと`BOT_IMAGE`の両方を戻す。次のブロックはRaspberry Pi以外の配備ホストで使う。配備時と同様に`.env.example`の差分を表示して入力待ちになるため、`.env.local`を確認してから巻き戻し先SHAを入力する。

```bash
export CURRENT_DEPLOY_SHA="<現在配備中の40文字のcommit SHA>"
export ROLLBACK_SHA="<直前の40文字のcommit SHA>"
export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$ROLLBACK_SHA"

if (
  git fetch origin &&
    git diff "$CURRENT_DEPLOY_SHA" "$ROLLBACK_SHA" -- .env.example &&
    printf 'Update .env.local if needed, then enter %s to continue: ' "$ROLLBACK_SHA" >&2 &&
    read -r reviewed_rollback_sha &&
    test "$reviewed_rollback_sha" = "$ROLLBACK_SHA" &&
    git switch --detach "$ROLLBACK_SHA" &&
    docker compose --env-file .env.local config -q &&
    docker compose --env-file .env.local pull bot &&
    docker compose --env-file .env.local up --no-build --pull never -d bot &&
    docker compose --env-file .env.local logs --tail=100 bot
); then
  echo "Rollback commands completed"
else
  echo "Rollback stopped after a failed command" >&2
  false
fi
```

Raspberry Piでは前の汎用ブロックを実行せず、次のPi専用ブロックを実行する。Pi用overrideとseccomp profileを必ず適用し、巻き戻すimageのnative moduleを実機検査してからBotを切り替える。

```bash
if export CURRENT_DEPLOY_SHA="<現在配備中の40文字のcommit SHA>" &&
  export ROLLBACK_SHA="<直前の40文字のcommit SHA>" &&
  export BOT_SECCOMP_PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/discord-translate/seccomp/aarch64-v28.5.2.json" &&
  export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$ROLLBACK_SHA" &&
  git fetch origin &&
  git diff "$CURRENT_DEPLOY_SHA" "$ROLLBACK_SHA" -- .env.example &&
  printf 'Update .env.local if needed, then enter %s to continue: ' "$ROLLBACK_SHA" >&2 &&
  read -r reviewed_rollback_sha &&
  test "$reviewed_rollback_sha" = "$ROLLBACK_SHA" &&
  git switch --detach "$ROLLBACK_SHA" &&
  docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml config -q &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml pull bot &&
    test "$(docker image inspect "$BOT_IMAGE" --format '{{.Architecture}}')" = "arm64" &&
    docker image inspect "$BOT_IMAGE" --format 'architecture={{.Architecture}} digest={{range .RepoDigests}}{{println .}}{{end}}' &&
    docker run --rm --pull never --platform linux/arm64 --network none --read-only \
      --security-opt "seccomp=$BOT_SECCOMP_PROFILE" \
      "$BOT_IMAGE" node scripts/smoke-runtime.mjs &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml \
      up --no-build --pull never -d bot &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml ps &&
    docker compose --env-file .env.local -f compose.yaml -f compose.pi.yaml logs --tail=100 bot; then
  echo "Raspberry Pi rollback commands completed"
else
  echo "Raspberry Pi rollback stopped after a failed command" >&2
  false
fi
```

コードとComposeを戻しても、SQLite schemaや外部設定が後方互換でなければ完全には戻らない。schema変更、環境変数の削除、永続化形式の変更を含むPRでは、旧imageで起動できるか、どのbackupから復旧するかを変更前に決める。

## 自動deployは運用境界が決まってから追加する

次の条件がそろった後、GitHub Environmentの承認を伴う別jobとして設計する。

- Piの既存SSH運用と分離した、deploy専用の認証主体と最小権限が決まっている
- Botの秘密情報をGitHub Actionsへ渡さずに更新できる
- `application_ready`以外の稼働確認とtimeoutが決まっている
- 失敗時に直前のimage digestへ戻す手順を実機で確認している
- 同時deployを防ぎ、1回の更新だけがhostを変更する
- 64-bit Raspberry Pi OSへ移行する場合、新しいDocker環境でnative moduleと実サービス起動を再確認している

条件が未確定の間は、手動配備の記録へcommit SHA、image digest、実施時刻、確認結果を残す。

## 用語

| 用語 | この文書での意味 |
|---|---|
| GHCR | GitHub Container Registry。検証済みDocker imageの配布先 |
| SHA tag | imageの生成元commitを示す`sha-<40文字のcommit SHA>`形式のtag |
| digest | image内容から決まる`sha256:...`形式の識別子。tagより厳密に同じimageを指定できる |
| rollback | 直前に正常稼働していたcommitのCompose定義とimageへ戻す操作 |

配備先固有の判断が必要で、この文書だけでは決められない場合は、対象commitと配備環境を添えてIssueで確認する。
