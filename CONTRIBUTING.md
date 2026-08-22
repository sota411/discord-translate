# 開発・引き継ぎガイド

この文書は、リポジトリを引き継いだ開発者が、既存の検証方法と構成上の判断を保ったまま変更するためのガイドである。初回は「変更前に共通検証を通す」と「ディレクトリは変更理由と外部依存で分ける」までを読む。CI、main保護、変更時の確認点は必要になったときに参照する。

Botを初めて起動する場合は[README](./README.md)、GHCRからの配備と巻き戻しは[運用手順](./docs/operations.md)を先に使う。

## 変更前に共通検証を通す

`package.json`はNode.jsの最低版とpnpmの版を宣言し、CIとDockerfileは再現性のためにNode.js 24.17.0を固定している。依存関係を入れた後、次のコマンドを実行する。

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify`は、開発者とCIが共有する検証入口である。内訳は次のとおり。

| 検証 | 確認する境界 |
|---|---|
| lint・型検査・自動テスト | ソース、公開コマンド、永続化結果、障害時の振る舞い |
| production build | 配布するJavaScriptを生成できること |
| runtime smoke | `better-sqlite3`と`@discordjs/opus`を現在のOSで読み込めること |
| diagram check | HTMLを正本とするSVGが同期済みであること |

図を直す場合は、`pnpm diagrams:sync`でSVGを更新してから`pnpm verify`を再実行する。`diagrams:check`はファイルを書き換えないため、失敗時に未保存の作業を変えない。

依存関係の脆弱性情報とコンテナまで含める場合は、次も確認する。auditは外部のadvisory情報、Docker検証はDocker Engineを必要とするため、`pnpm verify`とは分けている。

```bash
pnpm audit --prod
docker compose --env-file .env.local config -q
docker build --tag discord-translate:local .
```

`.env.local`がまだない場合、Compose設定検査だけなら`cp -n .env.example .env.local`で空の配布例を使える。`docker compose config`へ`-q`を付けずに実行すると、展開後の秘密値が端末へ出るため避ける。

実Discord・実SonioxのE2Eは、秘密情報、外部サービス、従量課金を必要とする。CIでは実行せず、リリース前の手動確認としてPRへ実施内容と未確認事項を残す。

## ディレクトリは変更理由と外部依存で分ける

このBotは、小さいうちから層やディレクトリを増やす方針を採らない。ひとつの責務で済む間は近くに置き、外部サービス、永続化、プロセス寿命など、別の理由で変更されることが明確になった時点で境界を作る。

| 場所 | 責務と分ける理由 |
|---|---|
| `src/index.ts` | process entrypoint。起動と終了シグナルだけを扱い、依存関係の組み立てを持ち込まない |
| `src/app.ts` | composition root。設定を読み、Discord、Soniox、SQLiteの実装を生成して接続する |
| `src/config*`、`src/config/` | 環境変数と翻訳用語を外部入力として検証する。起動後の処理へ未検証値を渡さない |
| `src/commands/` | コマンドの認可とユースケースを扱う。Discordの応答形式からセッション操作を分離する |
| `src/session/` | セッションの寿命、参加者変更、同時開始を管理する。音声や表示方法が変わっても状態規則を保つ |
| `src/discord/` | Discord API、Voice、カード、字幕スレッドとの境界。Discord固有の変更をここで受け止める |
| `src/soniox/` | Sonioxのモデル確認、容量、STT、TTS、利用量APIとの境界。provider固有の応答を上位へ漏らさない |
| `src/audio/`、`src/translation/` | PCM、発話確定、翻訳token、再生順序を扱う。DiscordやSonioxのclient生成とは分けて検証する |
| `src/usage/` | SQLiteによる利用量・費用・Guild登録用語の永続化を扱う。transactionと保持期限を一か所に置く |
| `src/observability/` | 生のDiscord IDや会話本文を出さず、運用に必要なログと遅延だけを記録する |
| `src/domain/` | 言語ペアと安定したエラーコードなど、外部実装に依存しない共有語彙を置く |
| `test/` | 内部の呼び出し順ではなく、コマンド、ログ、ファイル、SQLiteなど外から観測できる結果を優先して検証する |

この分け方はTypeScriptの定石を形だけ当てたものではない。`src/discord/`はDiscord APIの変更、`src/soniox/`はSoniox APIの変更、`src/usage/`は永続化と費用規則の変更を受けるため、変更理由が異なる。逆に、抽象的な`repository`や`service`を規則だけで追加すると、移動先が増える一方で責務が明確にならない。新しい境界は、異なる変更理由か依存方向を説明できる場合にだけ追加する。

## CIは検証し、CDは検証済みcommitを配布する

Pull RequestのCIは`.github/workflows/ci.yml`、main・version tag・手動実行からの公開は`.github/workflows/publish.yml`に分けている。

| 起点 | 実行するjob | 結果 |
|---|---|---|
| Pull Request | `verify` → `image` | `pnpm verify`、audit、Compose設定検査の後、`linux/amd64`と`linux/arm64`をbuildする。push権限は持たない |
| `main`へのpush | `verify` → `publish` | 同じcommitの2 platformを検証してから、multi-platform imageを`sha-<40文字のcommit SHA>`でGHCRへpushする |
| `v1.2.3`形式のtag | `verify` → `publish` | SHA tagに加え、完全なversion tagの`1.2.3`をGHCRへpushする |
| 手動実行 | `verify` → `publish` | 選択したrefを検証し、少なくともSHA tagをpushする |

CIとCDの境界はGHCRへのpushである。PRでは、秘密情報と`packages: write`を渡さず、Dockerfileからイメージを作れるところまで確認する。`publish`だけがjob単位で`packages: write`を持ち、BotのDiscord TokenやSoniox API Keyは参照しない。外部Actionはrelease tagではなくcommit SHAで固定し、Dependabotが更新候補を週次で作る。

公開workflowは、複数のmain・version tag実行が重なっても待機中のrunを置き換えないように、同じrepositoryの公開をキューへ入れて1件ずつ実行する。これにより、通常の連続mergeでも各commitのSHA tagを欠落させず、公開処理とbuild cacheの同時更新を避ける。実行順に依存する`main`、`1.2`、`latest`などの可変tagは作らない。

実行ホストへの自動接続はこのworkflowの責務に含めない。現在のRaspberry Pi配備は手動とし、deploy専用の最小権限、実サービスの機械的な稼働確認、失敗時の自動巻き戻しが実機で確立するまでは、GHCRへ配布可能な成果物を置くところで止める。

## mainはPRの2検査を必須にする

workflowがPull Requestで一度動いた後、GitHubの`Settings > Rules > Rulesets`でdefault branch用のrulesetを作る。設定は次のとおり。

1. `Require a pull request before merging`を有効にする。
2. `Require status checks to pass`へGitHub Actionsの`verify`と`image`を追加する。
3. 必要に応じて、merge前に最新のmainで再検証する設定を有効にする。
4. `Block force pushes`を有効にし、意図しないbypassを許可しない。

`publish`はPRで動かないため、必須checkには登録しない。mainへmergeした後の`publish`失敗は、Actions上で原因を直して再実行する。

## 変更理由に対応する文書と検証を更新する

- Node.jsまたはpnpmの版を変える場合は、`package.json`、Dockerfile、CIを同じ変更で更新する。
- 環境変数を変える場合は、`.env.example`、設定検証、READMEを更新する。
- 起動・配備方法を変える場合は、[運用手順](./docs/operations.md)と巻き戻し手順も更新する。
- Discordのコマンド定義を変える場合は、登録手順と実Discordでの確認結果をPRへ残す。
- SQLiteのschemaを変える場合は、旧イメージへ戻せるかを確認する。戻せない場合は、移行と復旧手順を実装より先に決める。
- 図のHTMLを変える場合は、`pnpm diagrams:sync`で対応するSVGもcommitする。

引き継ぎ時に判断の背景が不足している場合は、対象PRまたはIssueで確認する。確認できた内容が今後も必要なら、この文書か[設計書](./docs/design.md)へ理由と一緒に追記する。

## 用語

| 用語 | このリポジトリでの意味 |
|---|---|
| CI | Pull RequestでソースとDocker imageを検証する仕組み |
| CD | 検証済みDocker imageをGHCRへ公開するところまでの仕組み。実行ホストへのdeployは含めない |
| composition root | `src/app.ts`で具体的な外部依存を生成し、アプリケーションへ接続する場所 |
| runtime smoke | production dependencyのnative moduleを実際に読み込む最小検査 |
