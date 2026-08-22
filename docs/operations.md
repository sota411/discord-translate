# 配備・巻き戻し手順

この文書は、GHCRへ公開されたBotを配備・監視・巻き戻す運用担当者向けである。初回は「CDはGHCRへの公開で止める」「初回だけ配備ホストを準備する」までを読む。配備、ログ確認、巻き戻しは作業時に該当する節だけを参照する。

## CDはGHCRへの公開で止める

Pull RequestではソースとDockerイメージを検証する。`main`へのmerge後は、同じcommitを再検証してから`ghcr.io/sota411/discord-translate`へpushする。

自動化する範囲は、検証済みcommitから配備可能なイメージを公開するところまでである。実行ホストへの自動deployは行わない。ホスト、秘密情報の渡し方、稼働確認、失敗時の巻き戻し条件が未確定のためである。

現在の公開対象platformは`linux/amd64`である。Dockerfileは`better-sqlite3`と`@discordjs/opus`を対象platform向けにbuildするため、ARM64を追加する場合はQEMUを使ったbuildだけで完了扱いにしない。`linux/arm64`イメージ内のnative module読み込みと、実際のARM64ホストでの起動を確認してからmulti-platform manifestへ追加する。

## SHA tagで配備する版を固定する

| tag | 更新契機と用途 |
|---|---|
| `sha-<40文字のcommit SHA>` | main、version tag、手動公開で作る。通常の配備と巻き戻しに使う |
| `1.2.3` | Gitの`v1.2.3` tagから作るversion |

公開workflowは、どのcommitかが変わる`main`、`1.2`、`latest`などの可変tagを作らない。本番相当の運用では`sha-...`を使う。Docker tag自体は再度pushできるため、厳密に同じimageを固定する必要がある場合は、pull後に`RepoDigests`を記録し、`ghcr.io/sota411/discord-translate@sha256:...`を`BOT_IMAGE`へ指定する。

```bash
docker image inspect "$BOT_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}'
```

## 初回だけ配備ホストを準備する

配備ホストへDocker Engine、Docker Compose、Gitを用意する。Compose定義もimageと同じcommitへそろえるため、リポジトリをcloneする。

```bash
git clone https://github.com/sota411/discord-translate.git
cd discord-translate
export DEPLOY_SHA="<配備する40文字のcommit SHA>"
git switch --detach "$DEPLOY_SHA"

cp -n .env.example .env.local
chmod 600 .env.local
```

`.env.local`へDiscord Token、Soniox API Key、許可リスト、費用上限などを設定する。詳細は[README](../README.md)を参照する。秘密情報は配備ホストだけに置き、GitHub ActionsやDocker imageへ入れない。

GHCR packageがprivateの場合は、`read:packages`だけを持つpersonal access token（classic）でログインする。public packageを匿名でpullする場合、この操作は不要である。

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u sota411 --password-stdin
```

`GHCR_TOKEN`はホストのSecret管理へ保存する。Git、`.env.local`、コマンド引数へ値を直接書かない。

## publish成功後に同じcommitを配備する

1. GitHub Actionsで対象commitの`verify`と`publish`が成功していることを確認する。
2. 配備ホストのCompose定義を対象commitへ合わせる。
3. SHA tagを`BOT_IMAGE`へ設定し、ローカルbuildを禁止して起動する。

```bash
git fetch origin
export CURRENT_DEPLOY_SHA="<現在配備中の40文字のcommit SHA>"
export DEPLOY_SHA="<配備する40文字のcommit SHA>"
git diff "$CURRENT_DEPLOY_SHA" "$DEPLOY_SHA" -- .env.example
git switch --detach "$DEPLOY_SHA"
export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$DEPLOY_SHA"

docker compose --env-file .env.local config -q
docker compose --env-file .env.local pull bot
docker compose --env-file .env.local up --no-build --pull always -d bot
docker compose --env-file .env.local ps
docker compose --env-file .env.local logs --tail=100 bot
```

`.env.example`に差分がある場合は、既存の秘密値を保持したまま必要な設定だけを`.env.local`へ手動で反映する。`.env.local`を`.env.example`で上書きしない。反映後に次のCompose設定確認を行う。

上のコマンドは同じshellで続けて実行する。新しいshellを開いた場合は、`DEPLOY_SHA`と`BOT_IMAGE`を再設定してからComposeを実行する。

ログに`"event":"application_ready"`が出れば起動は完了している。起動に失敗して再起動を繰り返す場合は、先にBotを停止して原因を確認する。

```bash
docker compose --env-file .env.local stop bot
docker compose --env-file .env.local logs --tail=200 bot
```

Slash Commandの定義を変更したreleaseでは、Bot本体の更新とは別に登録する。

```bash
docker compose --env-file .env.local run --rm --no-deps bot node dist/register-commands.js
```

## 通常の状態確認はComposeから行う

```bash
docker compose --env-file .env.local ps
docker compose --env-file .env.local logs --tail=100 bot
docker compose --env-file .env.local logs --since=30m bot
```

このBotはHTTPのhealth endpointを持たない。現時点の機械的な起動確認はprocess状態と`application_ready`ログであり、実際の音声翻訳はREADMEの「最小確認」で確かめる。

## 巻き戻しではimageとCompose定義を同じSHAへ戻す

直前に正常稼働していたcommit SHAへ、host checkoutと`BOT_IMAGE`の両方を戻す。

```bash
export ROLLBACK_SHA="<直前の40文字のcommit SHA>"
git switch --detach "$ROLLBACK_SHA"
export BOT_IMAGE="ghcr.io/sota411/discord-translate:sha-$ROLLBACK_SHA"

docker compose --env-file .env.local config -q
docker compose --env-file .env.local pull bot
docker compose --env-file .env.local up --no-build --pull always -d bot
docker compose --env-file .env.local logs --tail=100 bot
```

コードとComposeを戻しても、SQLite schemaや外部設定が後方互換でなければ完全には戻らない。schema変更、環境変数の削除、永続化形式の変更を含むPRでは、旧imageで起動できるか、どのbackupから復旧するかを変更前に決める。

## 自動deployは運用境界が決まってから追加する

次の条件がそろった後、GitHub Environmentの承認を伴う別jobとして設計する。

- 配備ホストと接続方式が決まっている
- Botの秘密情報をGitHub Actionsへ渡さずに更新できる
- `application_ready`以外の稼働確認とtimeoutが決まっている
- 失敗時に直前のimage digestへ戻す手順を実機で確認している
- 同時deployを防ぎ、1回の更新だけがhostを変更する
- ARM64を対象に含める場合、native moduleと実サービス起動をARM64上で確認している

条件が未確定の間は、手動配備の記録へcommit SHA、image digest、実施時刻、確認結果を残す。

## 用語

| 用語 | この文書での意味 |
|---|---|
| GHCR | GitHub Container Registry。検証済みDocker imageの配布先 |
| SHA tag | imageの生成元commitを示す`sha-<40文字のcommit SHA>`形式のtag |
| digest | image内容から決まる`sha256:...`形式の識別子。tagより厳密に同じimageを指定できる |
| rollback | 直前に正常稼働していたcommitのCompose定義とimageへ戻す操作 |

配備先固有の判断が必要で、この文書だけでは決められない場合は、対象commitと配備環境を添えてIssueで確認する。
