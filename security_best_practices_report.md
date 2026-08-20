# 公開前セキュリティ監査報告

## 結論

2026年8月20日時点の現行リポジトリについて、Critical または High の確定した脆弱性は確認できませんでした。全追跡ファイル、到達可能な Git 履歴、到達不能な残存オブジェクトを検査しています。会話アーカイブも展開して調べましたが、実際の認証情報や秘密鍵は検出されませんでした。production 依存の既知脆弱性も0件です。

ただし、公開前に解消すべき Medium が2件あります。1件は、複数 Guild のセッションが同時に利用上限の事前判定を通過できるため、Global 上限を超過してから停止する競合です。もう1件は、Git 管理外の Playwright 出力が Docker のビルドコンテキストへ入る問題です。また、字幕の公開範囲と`ManageThreads`権限は、公開前に方針と実機挙動を確認する必要があります。

自動スキャンで秘密情報が検出されなかったことは、秘密情報や個人情報が存在しないことの証明ではありません。とくに会話アーカイブと設計用の参照資料は、所有者による内容・権利の確認が必要です。

## 監査範囲

- application code、test、script、CI、Dockerfile、Compose、設定例、文書
- Git が追跡する全ファイル
- 到達可能な Git 履歴
- 到達不能な1コミットと9ブロブ
- `discord_realtime_translation_chat.zip`内の2ファイル
- Discord の認可、thread、message、Voice、ログ境界
- Soniox の認証、固定 endpoint、STT/TTS wire、利用量・費用制御
- SQLite の schema、権限、保持期限
- production 依存と container 構成

実`.env.local`の値は、安全上の理由から表示も検査もしていません。ファイルモード、Git 除外、Docker build context からの除外だけを確認しました。また、実 Discord・実 Soniox、30分負荷、実課金、配置先は監査対象外です。

## 実行した確認

| 確認 | 結果 |
|---|---|
| `pnpm audit --prod` | 既知脆弱性0件 |
| `pnpm check` | lint・型検査・148テストが成功 |
| `pnpm build` | 成功 |
| `pnpm smoke:runtime` | SQLite・Opus ともに成功 |
| Docker build | 成功 |
| Semgrep TypeScript・secrets | application code 36ファイル、110 rules、finding 0 |
| Semgrep secrets | 全追跡ファイル、42ルール、検出0件 |
| Git 履歴スキャン | Semgrep の secrets rulesで、既知形式のトークン、秘密鍵、秘密値代入を検出せず |
| アーカイブスキャン | 既知トークン、秘密鍵、メールアドレス、Discord IDを検出せず |
| Git・Docker 除外 | 実設定、SQLite、実用語ファイルを除外 |
| ファイル権限 | ローカル`.env.local`は`0600`、SQLite は実装上`0600` |

旧依存の`tar@6.2.1`は現行 lockfileから除かれています。現在の production 経路は`tar@7.5.22`だけです。

## 再現手順

監査はリポジトリのルートで実行しました。使用した主なツールは次のとおりです。

| ツール | バージョン |
|---|---|
| Git | 2.55.0 |
| Semgrep | 1.161.0 |
| Node.js | 26.7.0 |
| pnpm | 11.3.0 |
| Docker | 29.7.2 |
| ripgrep | 15.2.0 |
| jq | 1.8.2 |
| Info-ZIP UnZip | 6.00 |

Semgrep のレジストリルールは更新される可能性があります。再検査時にはバージョンと実行日も記録してください。

アプリケーションコードには`p/typescript`と`p/secrets`を適用しました。監査時は36ファイルを110ルールで検査し、`findings: 0`、`errors: 0`でした。

```bash
semgrep scan --config p/typescript --config p/secrets \
  --json --quiet src test scripts \
  | jq '{findings: (.results | length),
         errors: (.errors | length),
         scanned_files: (.paths.scanned | length)}'
```

追跡中ファイルの検査には Bash を使います。対象は`git ls-files`が返すパスだけです。実`.env.local`、SQLite、Git 管理外の用語ファイルは意図的に含めません。監査時は`p/secrets`の42ルールで全83ファイルを検査し、`findings: 0`、`errors: 0`でした。

```bash
mapfile -d '' tracked_files < <(git ls-files -z)
semgrep scan --config p/secrets --json --quiet "${tracked_files[@]}" \
  | jq '{findings: (.results | length),
         errors: (.errors | length),
         scanned_files: (.paths.scanned | length)}'
```

Git 履歴は、全参照から到達できるブロブと、参照・reflogのどちらからも到達できない残存ブロブを分けて検査しました。次の手順は内容や検出文字列を表示せず、件数だけを出します。最終コミット後の到達不能オブジェクトは、commit 1件、blob 9件、tree 4件でした。到達可能なブロブ数は、コミットが増えると変わります。

```bash
set -euo pipefail
audit_dir="$(mktemp -d /tmp/discord-translate-public-audit.XXXXXXXX)"
cleanup_audit() { find "$audit_dir" -depth -delete; }
trap cleanup_audit EXIT

install -d -m 700 "$audit_dir/reachable" "$audit_dir/unreachable"
git rev-list --objects --all \
  | cut -d' ' -f1 \
  | git cat-file --batch-check='%(objectname) %(objecttype)' \
  | awk '$2 == "blob" {print $1}' \
  | sort -u > "$audit_dir/reachable-blob-ids"

while IFS= read -r oid; do
  git cat-file blob "$oid" > "$audit_dir/reachable/$oid.txt"
done < "$audit_dir/reachable-blob-ids"

git fsck --unreachable --no-reflogs --no-progress \
  > "$audit_dir/unreachable-objects"
awk '$2 == "blob" {print $3}' "$audit_dir/unreachable-objects" \
  | sort -u > "$audit_dir/unreachable-blob-ids"

while IFS= read -r oid; do
  git cat-file blob "$oid" > "$audit_dir/unreachable/$oid.txt"
done < "$audit_dir/unreachable-blob-ids"

semgrep scan --config p/secrets --json --quiet \
  "$audit_dir/reachable" "$audit_dir/unreachable" \
  | jq '{findings: (.results | length),
         errors: (.errors | length),
         scanned_files: (.paths.scanned | length)}'
awk '$1 == "unreachable" {count[$2]++}
     END {for (type in count) print type, count[type]}' \
  "$audit_dir/unreachable-objects" | sort
cleanup_audit
trap - EXIT
```

会話アーカイブは一時ディレクトリへ展開し、`p/secrets`に加えて、メールアドレスと17〜20桁の Discord ID候補を検索しました。監査時は2ファイルを検査し、どちらの検索も0件でした。`rg`は候補の内容を表示しないようにしています。

```bash
set -euo pipefail
archive_dir="$(mktemp -d /tmp/discord-translate-archive-audit.XXXXXXXX)"
cleanup_archive() { find "$archive_dir" -depth -delete; }
trap cleanup_archive EXIT

unzip -q discord_realtime_translation_chat.zip -d "$archive_dir"
semgrep scan --config p/secrets --json --quiet "$archive_dir" \
  | jq '{findings: (.results | length),
         errors: (.errors | length),
         scanned_files: (.paths.scanned | length)}'

if rg --files-with-matches --pcre2 \
  '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<![0-9])[0-9]{17,20}(?![0-9])' \
  "$archive_dir" >/dev/null; then
  printf 'personal_identifier_candidates=present\n'
else
  printf 'personal_identifier_candidates=0\n'
fi
cleanup_archive
trap - EXIT
```

依存関係、ビルド、Compose、コンテナは、次のコマンドで再検査できます。成功条件は、依存脆弱性0件、各コマンドの終了コード0です。Compose の`-q`は、展開後の秘密値を表示しません。

```bash
pnpm audit --prod
pnpm check
pnpm build
pnpm smoke:runtime
docker compose --env-file .env.local config -q
docker build --tag discord-translate:check .
```

## Findings

### 1. [Medium・公開前必須] 複数 Guild の競合で Global 上限を超過できる

確度: 高

セッション開始時の上限確認は、将来利用分を予約しません。別 Guild の2セッションがほぼ同時に開始すると、どちらも同じ未使用残高を見て開始できます。利用量はプロバイダーの利用後に加算され、その時点で初めて上限到達を検知します。

最小再現では、Global上限100に対し、2セッションがともに開始判定を通過しました。その後に各60を記録すると合計120になり、次の判定から拒否されました。上限検出時も、`onFailure`は障害を検出した Guild IDだけを渡すため、別 Guildの実行中セッションは直ちに停止しません。

根拠:

- `src/session/session-manager.ts:110-145`: 上限確認後に sessionを開始するが、予算を予約しない
- `src/usage/usage-ledger.ts:338-405`: provider利用を記録した後で User・Guild・Global上限を検査する
- `src/discord/translation-driver.ts:911-915`: runtime failureを1 Guildへ通知する
- `src/app.ts:122-133`: 通知された Guildだけを controllerへ渡す
- `src/session/session-manager.ts:274-285`: 全セッション停止は存在するが、通常は process終了時だけに使う

影響:

- 設定した Global上限を厳密な費用上限として扱えません。
- 同時 Guild数と停止までの provider利用量に応じて、上限を超過します。
- Soniox Project budgetの環境変数は、ローカル設定同士の大小比較にだけ使います。Consoleの実設定との一致は APIで確認しません。

対応案:

1. 公開初期は、process全体で同時1セッションに制限する
2. または、開始・参加前に予算を SQLite transactionで原子的に予約し、実績確定時に精算する
3. Global上限または Soniox 402を検出した場合は、`stopAll()`相当で全 Guildを停止する
4. 異なる Guildが同時開始・同時課金する公開境界 testを追加する

本監査では、依頼範囲を越えるためコードは変更していません。

### 2. [Medium・要判断] 字幕が音声参加者以外にも見える

確度: 高

Botは、親テキストチャンネルの messageから公開 threadを作ります。字幕には発話者の表示名、原文、翻訳文が含まれます。Discordの公開 threadは、親チャンネルを閲覧できる利用者からも見えます。アーカイブは削除ではありません。

根拠:

- `src/discord/session-presentation.ts:87-129`: 親チャンネルへカードを投稿し、公開 threadを作る
- `src/discord/message-payload.ts:135-177`: 表示名・原文・翻訳文を字幕に含める
- [Discord Threads](https://docs.discord.com/developers/topics/threads): 公開 threadは親チャンネルを閲覧できる利用者から見える

これは現行設計で意図した動作であり、直ちに脆弱性とは断定しません。ただし、private betaの User allowlistは字幕閲覧者を制限しません。また、参加者の同意を applicationが記録・強制する仕組みもありません。

対応案:

- 公開字幕、Sonioxへの音声送信、Discordへの字幕保存を利用条件へ明記する
- 親チャンネルの閲覧者を運用で制限する
- 必要なら private threadと参加者招待、または終了時削除へ変更する
- 保存期間、削除依頼、問い合わせ窓口を決める

### 3. [Medium・要実機確認] `ManageThreads`が最小権限を超えている

確度: 高

Botは`ManageThreads`を開始条件として要求します。現行処理は、自分で作成した threadを終了時にアーカイブするだけです。Discordは、thread作成者による`name`、`archived`、`auto_archive_duration`の編集を`ManageThreads`なしでも認めています。一方、`ManageThreads`を持つ利用者は、招待されていない private threadの閲覧や、他の threadの管理ができます。

根拠:

- `src/commands/translation-command-service.ts:360-372`: `ManageThreads`を必須権限として検査する
- `src/discord/bot-controller.ts:307-316`: Discord権限を Command Serviceへ渡す
- `src/discord/session-presentation.ts:189-203`: Bot自身の threadをアーカイブする
- [Discord Threads](https://docs.discord.com/developers/topics/threads): thread作成者の編集権限と`ManageThreads`の範囲

影響:

Bot Tokenまたはprocessが侵害された場合に、Bot自身の字幕 thread以外へ及ぶ権限が増えます。

対応案:

`ManageThreads`の要求を外し、Bot が自分で作成した公開スレッドを作成・投稿・アーカイブできるか、実 Discord で確認してください。必要時に再開できることも確認します。失敗する特定操作がある場合だけ、権限または設計を再検討します。

### 4. [Low] container侵害後の封じ込めが限定的

確度: 高

runtime containerは非root利用者で動き、privileged modeを使いません。一方、read-only root filesystem、capability全削除、`no-new-privileges`、PID・memory上限は設定していません。bridgeを作れないホスト向けの`compose.host.yaml`は host networkを使います。

根拠:

- `Dockerfile:17-30`: 非root runtimeと`/data`volume
- `compose.yaml:1-18`: 標準runtime設定
- `compose.host.yaml:1-7`: host network override

対応案:

- bridge構成を既定のまま維持する
- `cap_drop: [ALL]`と`no-new-privileges:true`を実機検証する
- root filesystemをread-onlyにし、`/data`と必要な一時領域だけを書き込み可能にする
- PID・memory上限を、30分負荷試験の実測後に設定する

### 5. [Low] CI Actionとbase imageを可変tagで参照している

確度: 高

CIは GitHub Actionsを`@v4`で参照し、Dockerfileは Node.jsイメージをバージョンタグで参照します。タグは上流で移動できます。GitHubは、完全なコミット SHAだけを不変な Actions参照として案内しています。

根拠:

- `.github/workflows/ci.yml:15-23`
- `Dockerfile:1,17`
- [GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)

対応案:

- Actionsを検証済みの完全 SHAへ固定し、元のバージョンタグをコメントとして残す
- base imageをdigestへ固定し、Dependabotなどで定期更新する

### 6. [Low・所有者確認] 会話 archiveと参照設計が公開対象に含まれる

確度: 公開対象であることは高、内容の公開可否は未確定

`discord_realtime_translation_chat.zip`と`docs/reference/design-structure-sample.md`は Git の追跡対象です。アーカイブ内の Markdown とテキストから、既知形式の認証情報や秘密鍵は検出されませんでした。メールアドレスと17〜20桁の Discord ID も検出されていません。ただし、自動スキャンでは、会話の機密性、第三者情報、著作権、公開意図を判定できません。

対応案:

- 所有者が内容と権利を全文確認し、公開を承認する
- 不要なら、public化前に現行treeだけでなく Git履歴からの除去要否も判断する

### 7. [Medium・公開前必須] Git 管理外の Playwright 出力が Docker のビルドコンテキストへ入る

確度: 高

`.playwright-cli/`と`coverage/`は`.gitignore`だけにあり、`.dockerignore`にはありません。現行作業ツリーには、Playwright のログとページスナップショットが8ファイルあります。これらはイメージへ`COPY`されませんが、`docker build .`のビルドコンテキストには入り、リモートビルダーを使う場合はホスト外へ送られます。

現存する8ファイルについて、Git の除外設定を無視する`--no-git-ignore`付きで`p/secrets`を適用しました。メールアドレス、17〜20桁の Discord ID、秘密鍵の候補も検索し、検出は0件でした。ただし、将来のブラウザーログやページスナップショットに、認証済み画面、Token、個人情報が含まれる可能性は残ります。

```bash
semgrep scan --no-git-ignore --config p/secrets \
  --json --quiet .playwright-cli \
  | jq '{findings: (.results | length),
         errors: (.errors | length),
         scanned_files: (.paths.scanned | length)}'

if rg --files-with-matches --pcre2 \
  '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<![0-9])[0-9]{17,20}(?![0-9])|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  .playwright-cli >/dev/null; then
  printf 'local_artifact_candidates=present\n'
else
  printf 'local_artifact_candidates=0\n'
fi
```

根拠:

- `.gitignore:9-11`: `coverage/`と`.playwright-cli/`を Git から除外する
- `.dockerignore:1-14`: 前記2ディレクトリを除外していない
- `Dockerfile:5-16`: 必要なパスだけを明示的に`COPY`するため、現行イメージ自体には入らない
- Docker build: 現行コンテキストをローカル Docker daemonへ送信することを確認
- [Docker Build context](https://docs.docker.com/build/concepts/context/): `.dockerignore`が送信前の除外を制御する

対応案:

- `.dockerignore`へ`.playwright-cli/`と`coverage/`を追加する
- Git 管理外のローカル出力が増えた場合も、ビルド前に除外状態を確認する
- 除外を直すまでは、認証済みブラウザー出力を持つ作業ツリーからリモートビルダーを使わない

## 問題を確認できなかった境界

次は、反証を試みましたが現行状態を壊せませんでした。

- Guild、操作利用者、音声参加者、途中参加者、Session IDを実行時に検査しています。
- Discord intentは`Guilds`と`GuildVoiceStates`だけです。
- 字幕 Markdownをescapeし、mention展開を無効にしています。
- 字幕長、用語数、WebSocket payload、STT接続待ち音声、待機TTS音声に上限があります。
- ログは例外 messageを捨て、Token、API Key、字幕本文、表示名、生の Discord IDを出しません。
- SQLiteは prepared statementとschema constraintを使い、音声・原文・翻訳文を保存しません。
- `.dockerignore`は実設定、Git、SQLite、ローカル用語を除外し、Dockerfileは必要なpathだけを`COPY`します。
- Soniox URLはregionから選ぶ固定 HTTPS・WSS endpointであり、利用者入力のURLへ接続しません。
- TTS wire eventは Zodで検証し、unknown streamを無視し、不正eventではconnectionを失敗させます。

## 未検証

- 実 Discord・実 Sonioxでの複数 Guild競合
- `ManageThreads`を外した後のthread lifecycle
- 30分以上の負荷、メモリ、PID、実課金
- Debian packageとnative moduleを含むcontainer image scan
- provider提供の網羅型secret scanner
- Repository rules、branch protection、GitHub secret scanning、Dependabotの有効状態
- 公開直前に追加されるcommitとtag

## 公開前チェックリスト

1. Finding 1の費用上限競合を修正し、異なる Guild間のtestを成功させる
2. Finding 7の Docker build context除外を修正し、リモートビルダーへ不要なファイルを送らない
3. 現行版の実サービスE2Eと30分負荷・費用照合を行う
4. 公開字幕、外部送信、保存・削除、同意の方針を決める
5. `ManageThreads`を外せるか実 Discordで確認する
6. 会話 archiveと参照設計を所有者が全文確認する
7. Actionとbase imageの固定方針を決める
8. LICENSE、`SECURITY.md`、脆弱性報告窓口を用意する
9. public化する直前のcommitで、秘密情報、依存監査、image scanを再実行する
