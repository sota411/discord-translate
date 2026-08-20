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

## セットアップ

### 1. Discord Applicationを設定する

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationを開き、Bot Tokenを発行する。TokenはGitやチャットへ貼らない。
2. `Public Bot`をOFFにする。Installation Contextsは`Guild Install`だけにし、常設のInstall Linkを無効にする。
3. OAuth2 URL Generatorで`bot`と`applications.commands`を選び、次の権限でテスト用サーバーへ追加する。生成したURLは配布しない。

   - View Channels
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Connect
   - Speak

4. Discordの開発者モードを有効にし、Server IDと、発話する全員のUser IDを取得する。

### 2. `.env.local`を作る

```bash
pnpm install --frozen-lockfile
cp -n .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

既存の`.env.local`がある場合、`cp`は実行しない。最後のコマンドの出力を`LOG_ID_HMAC_KEY`へ設定し、次の値を`.env.local`へ入力する。

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`
- `ALLOWED_GUILD_IDS`: Server IDをカンマ区切りで指定
- `ALLOWED_USER_IDS`: 発話する全員のUser IDをカンマ区切りで指定

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
6. [Sonioxの料金表](https://soniox.com/pricing)でSTT・TTS・テキストの単価を確認し、3つの単価と`PRICING_CONFIRMED_AT`を更新する。料金確認日が`PRICING_MAX_AGE_DAYS`を超えると起動できない。
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

`/translate`のDiscord側の既定権限は管理者のみ。一般メンバーへ許可する場合は、`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`でロールまたは利用者を指定する。BotはDiscord側とは別に許可リストを検査する。

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

## 使い方

1. 許可された利用者が同じ音声チャンネルへ参加する。
2. 字幕を表示してよい通常のテキストチャンネルで`/translate start`を実行し、言語ペアを選ぶ。モードを省略すると会話優先になる。
3. 親チャンネルのカードから、音声再生、再生モード、字幕失敗時の動作を変更する。
4. カードの停止ボタン、または`/translate stop`で終了する。

字幕用スレッドは公開スレッドである。親チャンネルを閲覧できるメンバーは字幕も閲覧できる。音声と字幕をDiscordとSonioxへ送ることについて参加者の同意を得て、機密情報を話さないチャンネルで使う。

## 最小確認

1. ログに`application_ready`があることを確認する。
2. 音声チャンネルへ参加し、`/translate start pair:日本語 ⇄ 韓国語 mode:会話優先`を実行する。
3. 日本語を話し、専用スレッドの仮字幕が確定字幕へ変わることと、韓国語の音声が再生されることを確認する。
4. `/translate stop`を実行し、Botの退出とカードの終了表示を確認する。

この確認だけでは、双方向会話、複数人の発話分離、日英・韓英、長時間運転は検証できない。

## 詳細資料

- [現行設計・設定一覧・受入条件](./docs/design.md)
- [公開前セキュリティ監査](./security_best_practices_report.md)
- [環境変数の配布例](./.env.example)
- [翻訳用語の例](./config/translation-terms.example.json)
