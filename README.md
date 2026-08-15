# Discord Realtime Translation Bot

許可したDiscordサーバーと利用者だけが使える、private beta向けのリアルタイム音声翻訳Botです。日本語・韓国語・英語から2言語を選び、確定した翻訳だけを同じ音声チャンネルで再生し、原文と翻訳文をテキストチャンネルへ投稿します。

設計の詳細は[docs/design.md](./docs/design.md)を参照してください。

## 現在の状態

- 実装済み: Guild/User許可リスト、Discord Voice受信・再生、Soniox STT/TTS、字幕、Soniox endpoint後だけのTTS生成、本文を送らないTTS接続ウォームアップ、endpoint順のFIFO再生、破損Opus packetの局所破棄、区間遅延ログ、SQLite利用量台帳、費用上限、利用ログ照合、graceful shutdown
- 自動確認済み: lint、型検査、公開境界・統合テスト、production build、native module smoke、Docker build
- 実機確認済み: 実Discordと実Sonioxの日韓1人通話、字幕、読み上げ、8発話の区間遅延計測。発話中にTTSへ確定翻訳を送るPoCも実施したが、通常操作と安定性を優先し、現行実装には採用していない
- 未確認: endpoint後にTTSを開始する現行版の実Discord遅延、複数人通話（3人を含む）、日英・韓英、3言語ペアの30分E2Eと料金受入。300 msは発話中TTSを採用しない現行方針と実測値が両立しないため、MVPの必須受入条件にはしない

Discordの音声受信はDiscord側で正式に文書化された安定APIではありません。`@discordjs/voice`は`0.19.2`へ固定しており、更新前に実機PoCを再実行してください。

## 事前に必要なもの

- Discord ApplicationのBot TokenとApplication ID
- Soniox Project専用API Key
- 許可するDiscord Server IDとUser ID
- セットアップ、設定確認、起動補助コマンド用のNode.js 24.17.0以上とpnpm 11.3.0
- Docker実行の場合は、上記に加えてDocker EngineとCompose

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

## 2. 環境変数を用意する

最初に依存関係をインストールします。

```bash
pnpm install --frozen-lockfile
```

続いて、設定ファイルを用意します。すでに`.env.local`がある場合は、秘密値を消さないよう、このコピー操作は実行しないでください。

```bash
cp .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

最後のコマンドの出力を`LOG_ID_HMAC_KEY`へ設定します。続いて、DiscordのToken、Application ID、Server ID、User IDを入力します。SonioxのAPI Keyは次の手順で入力します。

ローカルで直接起動する場合はSQLiteの絶対パスを作ります。

```bash
install -d -m 700 .data
realpath .data/usage.sqlite
```

表示されたパスを`SQLITE_PATH`へ設定してください。Docker Composeでは、ホスト側の設定にかかわらずコンテナ内の`/data/usage.sqlite`を使用します。

用語設定を使う場合は、[translation-terms.example.json](./config/translation-terms.example.json)をコピーし、その絶対パスを`TRANSLATION_TERMS_PATH`へ設定します。未使用なら空欄のままで構いません。

## 3. Sonioxを設定する

1. Soniox ConsoleでこのBot専用Projectを作り、Project API Keyを発行します。
2. API Keyを`.env.local`の`SONIOX_API_KEY`へ入力します。
3. Console上部が`Region: United States`なら、`SONIOX_REGION=us`のままにします。別途有効化するスイッチはありません。
4. Organization月額上限を`$15`、Project月額上限を`$5`として設定済みなら、`.env.example`の初期値と一致しています。
5. 利用可能なモデルとvoice IDを実APIで確認します。

```bash
pnpm soniox:inspect
```

`tts-rt-v2`とvoice IDが表示されれば、Sonioxの準備は完了です。voiceは確認済みの初期値`Kenji`、`Mina`、`Emma`をそのまま使用できます。変更したい場合だけ、`SONIOX_VOICE_JA`、`SONIOX_VOICE_KO`、`SONIOX_VOICE_EN`を書き換えてください。

最後に、値そのものを表示せず、不足している設定名と理由だけを確認します。

```bash
pnpm config:check
```

`設定は有効です。Botを起動できます。`と表示されるまで、指摘された項目を修正してください。既存の`.env.local`に初期値が足りない場合は、ファイルを上書きせず、`.env.example`の同名項目だけをコピーしてください。

## 4. Slash Commandを登録する

```bash
pnpm register-commands
```

コマンドは`ALLOWED_GUILD_IDS`のGuildだけへ登録されます。`default_member_permissions`は`0`なので、最初は管理者だけが利用できます。一般メンバーにも許可する場合は、Discordの`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`で対象ロールまたはメンバーを明示的に許可してください。runtimeのGuild/User許可リストは、この設定とは別に必ず検証されます。

## 5. Botを起動する

SQLiteはDocker管理の永続volumeへ保存します。通常のPCでは、次のコマンドで起動します。

```bash
pnpm docker:down
pnpm docker:up
pnpm docker:status
```

今回のように`failed to add the host ... veth ... operation not supported`が出るPCでは、Dockerのbridgeネットワークを作れません。そのPCだけ、明示的なhost network用設定を使って次の3行を実行します。

```bash
pnpm docker:host:down
pnpm docker:host:up
pnpm docker:host:status
```

このBotはポートを待ち受けませんが、host networkはDockerのネットワーク分離を弱めます。そのため、標準設定にはせず、上記のエラーが出るPCでだけ使用します。

最後の出力で`discord-translate-bot-1`の状態が`Up`になれば、コンテナは動いています。続いて起動ログを確認します。

```bash
# 通常のPC
pnpm docker:logs

# 今回のvethエラーが出るPC
pnpm docker:host:logs
```

ログに`"event":"application_ready"`があれば、DiscordとSonioxへの接続準備は完了です。
エラーがある場合は、省略せずこのコマンドの出力を共有してください。TokenやAPI Keyそのものはログへ出ません。

コードを更新した後は、`down`を先に実行する必要はありません。このPCでは次のコマンドがイメージを再ビルドし、Botコンテナを作り直します。

```bash
pnpm docker:host:up
pnpm docker:host:status
```

翻訳が遅いと感じた場合は、発話内容を表示せず区間時間だけを確認できます。

```bash
# 今回のvethエラーが出るPC
docker compose -f compose.yaml -f compose.host.yaml logs --since=30m bot \
  | rg '"event":"(translation_latency|translation_flow)"'

# 通常のPC
docker compose logs --since=30m bot \
  | rg '"event":"(translation_latency|translation_flow)"'
```

`translation_latency`では、同じ`trace_id`が1発話です。`stage:"playback_started"`の`total_ms`が、最後の音声packetからDiscordで再生を始めるまでの時間です。
`stage_ms`は直前に観測したstageとの差であり、字幕POSTとTTSは並行するため、常に同じstage順にはなりません。
音声再生は字幕POST完了を待たないため、`caption_posted`が`playback_started`より後に出る場合も正常です。

TTSのconfigと確定翻訳本文は、`stt_endpoint`の後にだけ送ります。Discordの`voice_speaking_started`で行うのはWebSocket接続だけで、config、本文、PCMは送りません。

`translation_flow`は本文やDiscord IDを含まない段階ログです。`voice_packet_dropped`は、Discordから受け取ったOpus packetを破損packetとして1件だけ破棄したことを表します。1回でセッションは停止しませんが、繰り返す場合はDiscord音声受信経路を調べてください。`voice_speaking_started`の後に`stt_endpoint_finalized`も`stt_endpoint_empty`も出ない場合は、Discord受信またはSTT経路を先に調べます。

音声のFIFO順は、Sonioxの`endpoint` eventをBotが受信した順です。先行音声が再生中なら、endpointで確定済みの後続1件だけをTTS生成して待機しますが、再生順を追い越しません。再生待ちは同じ`trace_id`の`playback_slot_ready.total_ms - queue_enqueued.total_ms`で確認します。

通常の発話後の遅延は、ミュート操作をせずに次の順で確認します。

- `stt_endpoint.total_ms`が大きい: Sonioxの発話終端確定待ちです。Discordのミュートは終端シグナルに使っていません。
- `stt_endpoint`から`tts_first_audio`までが大きい: endpoint確定後のTTS生成待ちです。
- `queue_enqueued`から`playback_slot_ready`までが大きい: FIFO内と先行音声の再生待ちです。
- `queue_enqueued`から`queue_started`までが大きい: 先行する確定発話のTTS生成開始待ちです。
- `playback_slot_ready`から`playback_started`までが大きい: 再生枠は空いていますが、TTS音声の準備などが終わっていません。

起動後によく使うコマンドは次のとおりです。

```bash
# 通常のPCで現在の状態を確認
pnpm docker:status

# 通常のPCでBotを停止してコンテナを削除
pnpm docker:down

# vethエラーが出るPCで停止してコンテナを削除
pnpm docker:host:down
```

停止しても、永続volumeのSQLiteは残ります。

SQLiteを含む永続volumeまで削除する`docker compose down -v`は、データを初期化するとき以外は実行しないでください。

`SIGINT`または`SIGTERM`を受けると、新規コマンドを拒否し、音声・Soniox接続・Discord接続・SQLiteを順に閉じます。

ローカル開発としてDockerを使わず起動する場合は、次を実行します。

```bash
pnpm dev
```

## 6. Discordで一人テストする

`pair:ja-ko`は日本語から韓国語だけではなく、日本語と韓国語の双方向翻訳です。話した言語を自動判定して、もう片方の言語で読み上げます。

1. Discordのメンバー一覧でBotがオンラインになったことを確認します。
2. `ALLOWED_USER_IDS`へ登録した自分が、通常のボイスチャンネルへ参加します。
3. 音声の回り込みを避けるため、イヤホンまたはヘッドホンを使用します。
4. 字幕を表示したいテキストチャンネルで`/translate start`と入力します。
5. `pair`で`ja-ko`を選択して送信します。
6. Botが同じボイスチャンネルへ参加し、テキストチャンネルへ開始通知を投稿したことを確認します。
7. 日本語で短く話します。韓国語の字幕と音声が返れば成功です。
8. `/translate stop`を実行します。Botがボイスチャンネルから退出すれば終了です。

参加者に関する注意点:

- 自分一人のテストでも、自分のUser IDを`ALLOWED_USER_IDS`へ設定します。
- 同じボイスチャンネルに別の人間がいる場合、その人も`ALLOWED_USER_IDS`へ登録されていないと開始を拒否します。
- 実行中に未許可の人間が参加した場合は、APIの不正利用を防ぐためセッションを自動停止します。
- 複数人で双方向会話を試す場合は、参加者全員を`ALLOWED_USER_IDS`へ登録します。
- 同時利用人数は`MAX_SPEAKERS_PER_SESSION`で1〜3人に設定します。

自動停止条件は、最大30分、120秒無音、参加者不在、未許可Userの参加、設定人数を超える参加、再生待ち10秒超過、利用上限、外部接続障害です。

### `/translate`が表示されない場合

まずGuild Commandを登録し直します。

```bash
pnpm register-commands
```

それでも表示されない場合は、Discordの`サーバー設定 > 連携サービス（Integrations） > 対象Bot > /translate`で、自分または自分のロールが許可されているか確認します。

### Dockerで同じvethエラーが出る場合

標準の[compose.yaml](./compose.yaml)へ、明示的な[compose.host.yaml](./compose.host.yaml)を重ねます。次の3行をそのまま実行してください。

```bash
pnpm docker:host:down
pnpm docker:host:up
pnpm docker:host:logs
```

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
