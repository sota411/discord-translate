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
- `SPEAKER_LANGUAGE_HINTS`: 任意。話者ごとの初期言語を`User ID:ja|ko|en`形式でカンマ区切りにして指定

話す言語が決まっている利用者には、`SPEAKER_LANGUAGE_HINTS`を設定する。Sonioxへ送る言語候補をその1言語に絞るため、短い発話で日本語と韓国語を取り違える可能性を減らせる。厳密な固定ではないため、言語識別と双方向翻訳は維持する。音声を待つ処理や前処理は追加しない。

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

`/translate`のDiscord側の既定権限は管理者のみ。一般メンバーへ許可する場合は、`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`でロールまたは利用者を指定する。`/status`、`/language`、`/export`、`/register`はGuildの全メンバーに表示されるが、実行時には4コマンドともBot側のGuild・User許可リストを検査する。`/translate start`にも同じ許可リストを適用する。`/translate stop`、`/translate speed`、カード操作は、開始者、対象音声チャンネルの参加者、または`ManageGuild`保持者だけが実行できる。

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
| `/language show [user:<利用者>]` | `user`を省略すると自分を表示する | 音声認識で優先する言語と、環境設定が使われているかを表示する |
| `/language set language:<言語> [user:<利用者>]` | 日本語、韓国語、英語、自動判定から選ぶ | Guildごとの設定を保存し、次に開始するセッションから反映する |
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

`/language`はGuildと利用者の組み合わせごとにSQLiteへ保存する。`user`を省略すると自分を対象にする。Botの許可リストに含まれる利用者同士なら、他の利用者も確認または変更できる。保存した設定は`SPEAKER_LANGUAGE_HINTS`より優先される。「自動判定」を保存すると、そのGuildでは環境設定を使わず、選択した言語ペアの2言語をSonioxへ渡す。設定言語がセッションの言語ペアに含まれない場合も、自動判定へ戻す。

字幕用スレッドは公開スレッドである。親チャンネルを閲覧できるメンバーは字幕も閲覧できる。音声と字幕をDiscordとSonioxへ送ることについて参加者の同意を得て、機密情報を話さないチャンネルで使う。

エクスポートしたMarkdownには会話本文が含まれる。Discordの公開スレッドと同じ情報として扱い、保存先と共有範囲を参加者と決めてから出力する。

## 最小確認

1. ログに`application_ready`があることを確認する。
2. `/language set language:<自分が話す言語>`を実行し、`/language show`で設定を確認する。
3. 音声チャンネルへ参加し、`/translate start pair:日本語 ⇄ 韓国語 mode:会話優先`を実行する。
4. 日本語を話し、再生中も仮字幕が更新され、発話の確定後に確定字幕へ変わることを確認する。
5. 韓国語の音声が再生されることを確認し、`/translate speed rate:1.3`を実行する。次の翻訳音声が1.3倍になり、再生中の音声は変わらないことを確認する。
6. `/status`を実行し、言語ペア、参加者、読み上げ速度、字幕スレッドが現在のセッションと一致することを確認する。
7. テスト専用のGuildとSQLiteで`/register add pair:日本語 ⇄ 韓国語 source:技術室 target:기술실`を実行する。
8. `/register list pair:日本語 ⇄ 韓国語`を実行し、登録した用語が表示され、現在のセッションの用語にはまだ反映されていないことを確認する。
9. 字幕スレッドで`/export`を実行し、添付されたMarkdownに確定字幕だけが時系列で含まれることを確認する。
10. `/translate stop`を実行し、Botの退出とカードの終了表示を確認する。
11. 同じ言語ペアでセッションを開始し直し、登録した用語を含む発話で翻訳への反映を確認する。
12. `/register delete pair:日本語 ⇄ 韓国語 source:技術室`を入力候補から選んで実行する。`/register list`から用語が消えても、実行中のセッションの用語は変わらないことを確認する。
13. セッションを停止して開始し直し、削除した用語が使われないことを確認してから停止する。

この確認だけでは、双方向会話、複数人の発話分離、日英・韓英、長時間運転、Discordの添付上限に近い大容量エクスポートは検証できない。

## 詳細資料

- [開発・引き継ぎガイド](./CONTRIBUTING.md)
- [配備・巻き戻し手順](./docs/operations.md)
- [現行設計・図解・設定一覧・受入条件](./docs/design.md)
- [公開前セキュリティ監査](./security_best_practices_report.md)
- [環境変数の配布例](./.env.example)
- [翻訳用語の例](./config/translation-terms.example.json)
