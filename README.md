# Discord Realtime Translation Bot

許可したDiscordサーバーと利用者だけが使える、private beta向けのリアルタイム音声翻訳Botです。日本語・韓国語・英語から2言語を選び、確定した翻訳だけを同じ音声チャンネルで再生し、原文と翻訳文をテキストチャンネルへ投稿します。

設計の詳細は[docs/design.md](./docs/design.md)を参照してください。

## 現在の状態

- 実装済み: Guild/User許可リスト、Discord Voice受信・再生、Soniox STT/TTS、字幕、FIFO再生、SQLite利用量台帳、費用上限、利用ログ照合、graceful shutdown
- 自動確認済み: lint、型検査、公開境界・統合テスト、production build、native module smoke、Docker build
- 未確認: 実Discordと実Sonioxを使った3言語ペアの30分E2E。漏えい済みの旧Token/API Keyをローテーションしてから実施する

Discordの音声受信はDiscord側で正式に文書化された安定APIではありません。`@discordjs/voice`は`0.19.2`へ固定しており、更新前に実機PoCを再実行してください。

## 事前に必要なもの

- Discord ApplicationのBot TokenとApplication ID
- Soniox Project専用API Key
- 許可するDiscord Server IDとUser ID
- ローカル実行の場合はNode.js 24.17.0以上とpnpm 11.3.0
- Docker実行の場合はDocker EngineとCompose

一人でも、VCへ参加して自分の発話が反対言語で返るところまでは確認できます。双方向会話と話者別処理の確認には、`ALLOWED_USER_IDS`へ追加したもう一人が必要です。

## 1. Discordを設定する

1. [Discord Developer Portal](https://discord.com/developers/applications)で対象Applicationを開きます。
2. `Bot`画面でBot Tokenを発行します。TokenをチャットやGitへ貼らないでください。
3. `Public Bot`をOFFにします。
4. `Installation`画面でInstallation Contextsを`Guild Install`だけにし、Install Linkを`None`にします。
5. Application OwnerがOAuth2 URL Generatorを一時的に使い、`bot`と`applications.commands`、次のBot権限だけを選んでテストサーバーへ追加します。URLは配布しません。
   - View Channels
   - Send Messages
   - Connect
   - Speak
6. Discordの`ユーザー設定 > 詳細設定 > 開発者モード`をONにします。サーバーと自分を右クリックして、それぞれ`IDをコピー`します。

IDは、公開を防ぐruntime許可リストに必要です。自分一人のデバッグでもServer IDと自分のUser IDは設定します。

## 2. Sonioxを設定する

1. Soniox ConsoleでこのBot専用Projectを作り、Project API Keyを発行します。
2. Console上部が`Region: United States`なら、`.env.local`の`SONIOX_REGION=us`を使います。別途有効化するスイッチはありません。
3. Organization月額上限を`$15`、Project月額上限を`$5`として設定済みなら、`.env.example`の初期値と一致しています。
4. API Keyとregionだけを`.env.local`へ入力した後、利用可能なモデルとvoice IDを確認します。

```bash
pnpm soniox:inspect
```

出力された`tts-rt-v2`のvoice IDから使用するものを選び、`SONIOX_VOICE_JA`、`SONIOX_VOICE_KO`、`SONIOX_VOICE_EN`へ設定します。同じ多言語voiceを3項目へ設定しても構いません。

## 3. 環境変数を用意する

```bash
cp .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

最後のコマンドの出力を`LOG_ID_HMAC_KEY`へ設定します。続いて、空欄のToken、API Key、Application ID、Server ID、User ID、voice IDを入力します。

ローカルで直接起動する場合はSQLiteの絶対パスを作ります。

```bash
install -d -m 700 .data
realpath .data/usage.sqlite
```

表示されたパスを`SQLITE_PATH`へ設定してください。Docker Composeでは`SQLITE_PATH=/data/usage.sqlite`のまま使えます。

用語設定を使う場合は、[translation-terms.example.json](./config/translation-terms.example.json)をコピーし、その絶対パスを`TRANSLATION_TERMS_PATH`へ設定します。未使用なら空欄のままで構いません。

## 4. Slash Commandを登録する

```bash
pnpm install --frozen-lockfile
pnpm register-commands
```

コマンドは`ALLOWED_GUILD_IDS`のGuildだけへ登録されます。`default_member_permissions`は`0`なので、最初は管理者だけが利用できます。一般メンバーにも許可する場合は、Discordの`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`で対象ロールまたはメンバーを明示的に許可してください。runtimeのGuild/User許可リストは、この設定とは別に必ず検証されます。

## 5. 起動する

ローカル開発:

```bash
pnpm dev
```

Docker Compose:

```bash
install -d -m 700 .data
docker compose up --build -d
docker compose logs -f bot
```

停止:

```bash
docker compose down
```

`SIGINT`または`SIGTERM`を受けると、新規コマンドを拒否し、音声・Soniox接続・Discord接続・SQLiteを順に閉じます。

## 6. Discordで確認する

1. 許可済みUserがテストVCへ参加します。
2. 字幕を残すテキストチャンネルで`/translate start pair:ja-ko`などを実行します。
3. 通常メッセージで開始通知が出たことを確認してから話します。
4. 字幕が`再生待ち`から`再生済み`へ更新され、同じVCで翻訳音声が聞こえることを確認します。
5. `/translate stop`を実行し、BotがVCから退出することを確認します。

自動停止条件は、最大30分、120秒無音、参加者不在、未許可Userの参加、3人目の参加、再生待ち10秒超過、利用上限、外部接続障害です。

## 開発時の確認

```bash
pnpm check
pnpm build
pnpm smoke:runtime
pnpm diagrams:sync
docker build --tag discord-translate:local .
```

実APIへ接続しないテストは、Soniox TTS WebSocketのローカルfixtureを含めて実行されます。実機E2Eの記録項目と合格条件は[検証方針](./docs/design.md#検証方針)にあります。

## セキュリティ上の注意

- `.env.local`はGitとDocker build contextから除外されています。
- Botは外部向けHTTPポートを開きません。
- API KeyをDiscordへ渡さず、BotプロセスからだけSonioxへ接続します。
- 音声、原文、翻訳文、表示名はSQLiteや構造化ログへ保存しません。字幕はDiscord上に残ります。
- 公開Botへ変更する場合は、運営者のAPI Keyを共有する方式を継続せず、BYOKまたは利用者別課金を先に設計してください。
