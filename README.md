# Discord Realtime Translation Bot

Discordの音声チャンネルで、日本語・韓国語・英語の会話を双方向に翻訳するBotである。翻訳音声は同じ音声チャンネルへ返し、字幕はセッション専用の公開スレッドへ表示する。対象は、許可したサーバーと利用者だけが使う限定公開の試用版である。

対応する言語ペアは日韓・日英・韓英で、参加者は1〜3人である。標準の運用経路はDocker Composeで、Node.jsでも直接動かせる。

> [!WARNING]
> 現行版のDiscord・Soniox E2E、2〜3人通話、30分運転は未検証。字幕は公開スレッドへ残り、自動削除されない。利用範囲を広げる前に[設計書](./docs/design.md)と[公開前セキュリティ監査](./security_best_practices_report.md)を確認する。

## 必要なもの

- Discord ApplicationのBot TokenとApplication ID
- 許可するDiscord Server IDとUser ID
- Sonioxアカウント
- Node.js 24.17.0以上
- pnpm 11.3.0
- Dockerで動かす場合はDocker EngineとDocker Compose
- Linuxシェル、`openssl`

## まずビルドとテストを再現する

秘密情報を用意する前に、リポジトリをcloneしてローカル検証を通す。`pnpm verify`はDiscordやSonioxへ接続しない。

Node.jsは24.17.0以上、pnpmは11.3.0を使う。`pnpm`がない場合は、Node.jsを導入した後に`npm install --global pnpm@11.3.0`で用意する。

```bash
git clone https://github.com/sota411/discord-translate.git
cd discord-translate

node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm verify
```

検証ではlint、型検査、自動テスト、本番用build、SQLiteとDiscord Opusの読み込み、設計図の同期を確認する。

## セットアップ

### 1. Discord Applicationを設定する

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationを開き、Bot Tokenを発行する。TokenはGitやチャットへ貼らない。
2. `Public Bot`をOFFにする。Installation Contextsは`Guild Install`だけにし、常設のInstall Linkを無効にする。
3. OAuth2 URL Generatorで`bot`と`applications.commands`を選び、次の権限でテスト用サーバーへ追加する。生成したURLは配布しない。

   - View Channels
   - Read Message History
   - Send Messages
   - Attach Files
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Connect
   - Speak

4. Discordの開発者モードを有効にし、Server IDと、発話する全員のUser IDを取得する。

### 2. `.env.local`を作る

```bash
cp -n .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

既存の`.env.local`がある場合、`cp`は実行しない。最後のコマンドの出力を`LOG_ID_HMAC_KEY`へ設定し、次の値を`.env.local`へ入力する。

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`
- `ALLOWED_GUILD_IDS`: Server IDをカンマ区切りで指定
- `ALLOWED_USER_IDS`: 発話する全員のUser IDをカンマ区切りで指定

旧版から既存の`.env.local`を引き継ぐ場合は、秘密値を保持したまま、今回変更した次の非secret設定も更新する。ファイル全体を`.env.example`で上書きしない。

```dotenv
SESSION_MAX_MINUTES=120
STT_COST_MICROUSD_PER_HOUR=60000
TTS_COST_MICROUSD_PER_HOUR=645000
TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND=1200000
PRICING_CONFIRMED_AT=2026-08-22
```

Node.jsで直接動かす場合は、SQLiteの保存先を作り、絶対パスを`SQLITE_PATH`へ設定する。

```bash
install -d -m 700 .data
realpath .data/usage.sqlite
```

Docker Composeは、SQLiteを名前付きボリュームの`/data/usage.sqlite`へ保存する。

### 3. Soniox Projectを設定する

1. [Soniox Console](https://console.soniox.com/)で、このBot専用のProjectとAPI Keyを作る。
2. Projectと同じリージョンを`SONIOX_REGION`へ設定する。設定できる値は`us`、`eu`、`jp`。
3. API Keyを`SONIOX_API_KEY`へ設定する。
4. Consoleで設定したProjectの月額上限をmicroUSDに換算し、`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`へ設定する。5 USDなら`5000000`。
5. 利用上限が`USER <= GUILD <= GLOBAL < SONIOX_PROJECT`を満たすように設定する。
6. [Sonioxの料金表](https://soniox.com/pricing)でSTT入力音声・TTS出力音声・テキストのtoken単価と換算目安を確認し、3つの単価と`PRICING_CONFIRMED_AT`を更新する。配布値は音声とテキストを別々に見積もり、合計へ安全係数を掛ける。料金確認日が`PRICING_MAX_AGE_DAYS`を超えると起動できない。
7. STT・TTSモデルと、TTSの3言語・3つの多言語voiceを確認する。

```bash
pnpm soniox:inspect
```

`stt_models`で設定したSTTモデルを確認する。`tts_models`では、設定したTTSモデル、3言語、3つのvoiceを確認する。STTの3言語と3言語ペアはBotの起動時に検査する。

`SONIOX_VOICE_JA`、`SONIOX_VOICE_KO`、`SONIOX_VOICE_EN`は、3人までの話者に固定で割り当てる音声枠である。互いに異なるvoiceを設定する。

### 4. 設定を検査し、コマンドを登録する

```bash
pnpm config:check
pnpm register-commands
```

`config:check`が`設定は有効です。Botを起動できます。`と表示すれば、設定検査は完了する。`register-commands`が許可したサーバーごとに`"event":"guild_commands_registered"`を1件出せば登録は完了する。登録に失敗した場合は、Token、Application ID、Botを追加したサーバーを確認する。

`config:check`の失敗出力には、翻訳用語やファイルパスが含まれる場合がある。公開先へ貼らない。

`/translate`のDiscord側の既定権限は管理者のみ。一般メンバーへ許可する場合は、`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`でロールまたは利用者を指定する。`/status`、`/export`、`/register`はGuildの全メンバーに表示されるが、実行時には3コマンドともBot側のGuild・User許可リストを検査する。`/translate start`にも同じ許可リストを適用する。`/translate stop`、`/translate speed`、カード操作は、開始者、対象音声チャンネルの参加者、または`ManageGuild`保持者だけが実行できる。

既存環境へ新しいコマンドを追加するときも、コード更新後に`pnpm register-commands`を実行し、Botを再起動する。

## 起動

標準構成のDocker Composeを使う場合:

```bash
pnpm docker:up
pnpm docker:status
pnpm docker:logs
```

Node.jsで直接動かす場合:

```bash
pnpm dev
```

本番相当のJavaScriptを動かす場合は、`pnpm build`の後に`pnpm start`を実行する。

ログに`"event":"application_ready"`が出れば起動が完了する。

Docker Composeで`application_start_failed`が繰り返される場合は、`pnpm docker:logs`で失敗を確認し、`pnpm docker:down`で再起動を止める。Node.jsで失敗した場合は、その端末で`application_start_failed`を確認する。どちらも`pnpm config:check`と`pnpm soniox:inspect`を再実行し、原因を直してから起動する。

Docker Composeを停止する場合:

```bash
pnpm docker:down
```

Node.jsで直接起動した場合は、`Ctrl+C`で停止する。

### Raspberry Piで常時運用する場合

Raspberry PiではPi上でimageをbuildせず、CIで検証してGHCRへ配布した`linux/arm64` imageをcommit SHAタグで固定して使う。通常の`compose.yaml`に`compose.pi.yaml`を重ね、秘密情報はPi上の`.env.local`から起動時に渡す。GitHub ActionsからPiへの自動deployはまだ行わない。

初回配備、SQLiteデータの移行、ログ確認、更新、rollbackは[配備・巻き戻し手順](./docs/operations.md)に従う。既存のSQLiteを移す場合は、旧BotとPi上のBotを同時に起動しない。

## 使い方

1. 許可された利用者が同じ音声チャンネルへ参加する。
2. 字幕を表示してよい通常のテキストチャンネルで`/translate start`を実行し、言語ペアを選ぶ。モードを省略すると会話優先になる。
3. 必要なら`/translate speed rate:1.3`のように指定し、現在のセッションの読み上げ速度を0.7〜1.3倍へ変更する。変更は次に生成する翻訳音声から反映される。
4. 親チャンネルのカードから、音声再生、再生モード、字幕失敗時の動作を変更する。
5. カードの停止ボタン、または`/translate stop`で終了する。

翻訳中の状態確認、字幕の保存、固有名詞の登録には、次のコマンドを使う。応答とエクスポートファイルは実行者だけに表示される。

| コマンド | 使い方 | 結果 |
|---|---|---|
| `/translate speed rate:<0.7〜1.3>` | 例: `rate:1.3` | 現在のセッションだけ読み上げ速度を変え、次に生成する翻訳音声から反映する |
| `/status` | 引数なし | 現在の状態、言語ペア、参加者、経過時間、モード、読み上げ速度、音声の有無、字幕スレッドを表示する |
| `/export` | 翻訳用の公開スレッド内で実行する | 現在のスレッドにあるBotの確定字幕を、時系列のMarkdownファイルとして出力する |
| `/export thread:<公開スレッド>` | 別のチャンネルから対象を指定する | 指定した公開スレッドを同じ条件で出力する |
| `/register add pair:<言語ペア> source:<用語> target:<希望する翻訳>` | 例: `source:技術室 target:technology room` | Guild用の翻訳用語を登録または更新し、次に開始するセッションから反映する |
| `/register list [pair:<言語ペア>]` | `pair`を省略すると全言語ペアを表示する | Guildに登録した翻訳用語を一覧表示する |
| `/register delete pair:<言語ペア> source:<用語>` | `source`は入力候補から選べる | Guildに登録した翻訳用語をすぐに削除し、次に開始するセッションから使わない |

`/export`は、人間が投稿したメッセージ、仮字幕、再生待ちの字幕、終了通知を出力しない。対象スレッドの全履歴を取得し、Botが現在のComponents V2形式で投稿した確定字幕だけを選ぶ。この処理ではMessage Content Intentを使わない。実行者とBotには対象スレッドの`View Channel`と`Read Message History`が必要で、Botには応答先の`Attach Files`も必要になる。MarkdownがDiscordの添付上限を超えた場合は、内容を切り詰めずに失敗する。

終了後にアーカイブされた翻訳スレッド内で`/export`を実行した場合、Botはそのスレッドを一時的に再開し、ファイルを返信した後に再アーカイブする。

`/register add`はGuildと言語ペアごとにSQLiteへ保存する。`source`と`target`はそれぞれ100文字以内で指定する。前後の空白は取り除き、大文字と小文字を含めて完全一致で判定する。同じ`source`をもう一度登録すると`target`を更新する。運用者が`TRANSLATION_TERMS_PATH`で定義した同じ`source`は上書きできない。静的用語と登録用語を合わせたSoniox contextが10,000文字を超える登録も拒否する。更新前の版で保存した用語も起動時に100文字上限を検査し、違反があれば起動せず運営者へ通知する。

`/register list`は、`/register add`でGuildへ登録した用語だけを1ページ10件まで表示する。`pair`を省略すると、日本語・韓国語、日本語・英語、韓国語・英語の順にすべて表示する。件数が多い場合は「前へ」と「次へ」で移動でき、ページを移動するたびにSQLiteから最新の一覧を読み直す。`TRANSLATION_TERMS_PATH`で定義した静的用語は表示しない。

`/register delete`では、言語ペアを選ぶと、そのGuildに登録した`source`を入力候補から選べる。候補は入力文字との部分一致で絞り込み、大文字と小文字は区別しない。コマンドを実行すると確認画面を挟まずに削除する。静的用語は候補へ出さず、コマンドでも削除できない。登録と削除は実行中または開始処理中のセッションを変えず、次に開始するセッションから反映する。

字幕用スレッドは公開スレッドである。親チャンネルを閲覧できるメンバーは字幕も閲覧できる。音声と字幕をDiscordとSonioxへ送ることについて参加者の同意を得て、機密情報を話さないチャンネルで使う。

エクスポートしたMarkdownには会話本文が含まれる。Discordの公開スレッドと同じ情報として扱い、保存先と共有範囲を参加者と決めてから出力する。

## 最小確認

1. ログに`application_ready`があることを確認する。
2. 音声チャンネルへ参加し、`/translate start pair:日本語 ⇄ 韓国語 mode:会話優先`を実行する。
3. 日本語を話し、再生中も仮字幕が更新され、発話の確定後に確定字幕へ変わることを確認する。
4. 韓国語の音声が再生されることを確認し、`/translate speed rate:1.3`を実行する。次の翻訳音声が1.3倍になり、再生中の音声は変わらないことを確認する。
5. `/status`を実行し、言語ペア、参加者、読み上げ速度、字幕スレッドが現在のセッションと一致することを確認する。
6. テスト専用のGuildとSQLiteで`/register add pair:日本語 ⇄ 韓国語 source:技術室 target:기술실`を実行する。
7. `/register list pair:日本語 ⇄ 韓国語`を実行し、登録した用語が表示され、現在のセッションの用語にはまだ反映されていないことを確認する。
8. 字幕スレッドで`/export`を実行し、添付されたMarkdownに確定字幕だけが時系列で含まれることを確認する。
9. `/translate stop`を実行し、Botの退出とカードの終了表示を確認する。
10. 同じ言語ペアでセッションを開始し直し、登録した用語を含む発話で翻訳への反映を確認する。
11. `/register delete pair:日本語 ⇄ 韓国語 source:技術室`を入力候補から選んで実行する。`/register list`から用語が消えても、実行中のセッションの用語は変わらないことを確認する。
12. セッションを停止して開始し直し、削除した用語が使われないことを確認してから停止する。

この確認だけでは、双方向会話、複数人の発話分離、日英・韓英、長時間運転、Discordの添付上限に近い大容量エクスポートは検証できない。

## STT精度の変更は同じ音声で比較する

`pnpm stt:evaluate`は、許可済みのPCM音声とpacket traceを同じ順序でSonioxへ送り、現行条件と候補条件を比較する。実行にはSonioxの利用料金がかかる。個人音声はGitへ追加せず、`.data/stt-eval/`へ置く。

```bash
install -d -m 700 .data/stt-eval

pnpm stt:evaluate run \
  --manifest .data/stt-eval/manifest.json \
  --observations-output .data/stt-eval/observations.json \
  --output .data/stt-eval/report.json
```

manifestには、48 kHz・mono・PCM s16le音声、正解文、期待する言語と分割数、固有名詞、翻訳用語を記録する。packet traceには、packetごとの送信時刻・byte数と、発話全体の欠落数を記録する。詳しいfieldは[設計書のSTT評価](./docs/design.md#stt候補は同じ音声のadで採否を決める)を参照する。

`observations.json`には認識本文が含まれるため、0600でローカル保存し、公開または共有しない。`report.json`には本文と音声を含めず、入力のSHA-256、CER、固有名詞再現率、言語再現率、分割数、平均・p50・p95遅延、CPU、packet欠落だけを出力する。別の端末で採点し直す場合は、次のコマンドを使う。音声かpacket traceが変わっていれば、SHA-256の不一致で失敗する。

```bash
pnpm stt:evaluate score \
  --manifest .data/stt-eval/manifest.json \
  --observations .data/stt-eval/observations.json \
  --output .data/stt-eval/report.json
```

評価profileは次の4つである。

| ID | 認識用context | 発話確定 |
|---|---|---|
| A | なし | 現行。Discordの発話終了から100 ms後に手動確定 |
| B | `general`と登録語の`terms` | Aと同じ |
| C | なし | Soniox上限500 ms、手動fallback 600 ms |
| D | Bと同じ | Cと同じ |

2026年8月25日に人工音声10件でA〜Dを実測した。Bは全体CERを11.1%改善したが、固有名詞再現率と日韓切り替え時の期待言語再現率が悪化した。Cは全体CERと固有名詞再現率を改善し、Soniox endpointが境界の60%を占めたが、コードスイッチCERが33.3ポイント、p95遅延が約479 ms、不自然な分割数が9件悪化した。DはコードスイッチCERが66.7ポイント、p95遅延が約483 ms悪化し、Soniox endpointも境界の33.3%に留まった。いずれも採用基準を満たさないため、通常運用の確定値と`SONIOX_GENERAL_CONTEXT_ENABLED=false`は変更していない。数値と入力SHA-256は[本文非含有レポート](./docs/evaluation/stt-artificial-2026-08-25.json)に残している。

この結果は人工音声に限られる。実際のDiscord音声、複数人通話、Raspberry PiのCPUと音声詰まりは未検証であり、本番で改善した証拠にはならない。RNNoiseやDeepFilterNetも、ノイズ音声で10%以上改善し、クリーン音声を悪化させない実測がないため追加していない。標準経路は引き続き無加工PCMである。

## 詳細資料

- [開発・引き継ぎガイド](./CONTRIBUTING.md)
- [配備・巻き戻し手順](./docs/operations.md)
- [現行設計・図解・設定一覧・受入条件](./docs/design.md)
- [2026-08-25 STT人工音声評価（本文非含有）](./docs/evaluation/stt-artificial-2026-08-25.json)
- [公開前セキュリティ監査](./security_best_practices_report.md)
- [環境変数の配布例](./.env.example)
- [翻訳用語の例](./config/translation-terms.example.json)
