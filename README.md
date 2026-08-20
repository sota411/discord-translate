# Discord Realtime Translation Bot

Discord の音声チャンネルで、日本語・韓国語・英語の会話を双方向に翻訳する Bot です。対象は、許可したサーバーと利用者だけが使う限定公開の試用版（private beta）です。翻訳音声は同じ音声チャンネルへ返し、認識中の仮字幕と確定字幕はセッション専用の公開スレッドへ表示します。

- 対応する言語ペアは、日本語・韓国語、日本語・英語、韓国語・英語です。
- 同時参加者は1〜3人です。配布設定の初期値は2人です。
- 再生モードは、会話優先と正確さ優先の2種類です。
- Node.js または Docker Compose で実行できます。

内部設計は [docs/design.md](./docs/design.md)、公開前の安全性調査は [security_best_practices_report.md](./security_best_practices_report.md)を参照してください。

## 現在の状態

2026年8月20日時点の現行実装について、次を確認しています。詳細と更新時の正本は、[設計書の「現在の検証状態」](./docs/design.md#3-現在の検証状態)です。

| 区分 | 状態 |
|---|---|
| 自動検証 | `pnpm check`の lint・型検査・148テスト、本番用ビルド、ネイティブモジュールの実行検査、本番向けの依存関係の監査、Compose 設定検証、Docker ビルドが成功 |
| 実機検証の履歴 | 以前の UI を使い、実際の Discord・Soniox 環境で日韓1人通話、字幕、読み上げ、8発話の区間遅延を確認 |
| 現行版で未検証 | セッションカード、専用スレッド、仮字幕、2つの再生モード、話者別の音声を含む、実際の Discord・Soniox 環境での E2E |
| 規模・継続運転で未検証 | 2〜3人通話、日英・韓英、30分継続、実請求額との照合精度、複数サーバーの同時運転 |

過去の実機検証は、現行版全体の受入完了を意味しません。また、300 ms以内の再生開始は、発話境界を確定してから音声合成へ本文を送る現行方式と両立しません。そのため、実用最小限の製品（MVP）の必須条件にはしていません。

Discord の音声受信は、Discord が安定版 API として正式に文書化している機能ではありません。`@discordjs/voice`は`0.19.2`へ固定しています。更新時には、実際の Discord 環境で音声受信を再検証してください。

## 動作の概要

1. 利用者が音声チャンネルへ参加し、テキストチャンネルで`/translate start`を実行します。
2. Bot がサーバー、利用者、参加人数、Discord 権限、利用上限、Soniox の同時実行枠を確認します。
3. Bot が親テキストチャンネルへセッションカードを投稿し、そのカードから公開スレッドを作ります。
4. 発話者ごとに音声を Soniox の音声認識・翻訳（STT）へ送り、認識中の仮字幕を最大500 ms間隔で更新します。
5. Soniox の`endpoint`、Discord の発話終了後の manual finalize（手動確定）、認識停滞3秒、または発話長上限によって発話を確定します。
6. 確定字幕の投稿と音声合成（TTS）を並行して始め、確定順を保って翻訳音声を再生します。

`conversation`（会話優先）では、待ち時間が2.5秒を超えた音声を省略し、新しい発話が始まると再生中の翻訳を中断します。`accuracy`（正確さ優先）では、遅延を表示しながら、先に確定した発話から再生する順序（FIFO）を維持します。

## 事前に必要なもの

- Discord Application の Bot Token と Application ID
- Soniox アカウント。専用 Project と API Key はセットアップ中に作成します。
- 許可する Discord Server ID と User ID
- Node.js 24.17.0以上
- pnpm 11.3.0
- Docker で実行する場合は Docker Engine と Docker Compose
- 本書のコマンド例は、Git から取得した作業ツリーと Linux のシェルを前提とします。`git`、`openssl`、GNU coreutils、ログ確認用の`rg`が必要です。ソースアーカイブだけを取得した場合は、受入試験でコミット SHA を記録できません。

一人でも、自分の発話が、選択した言語ペアのもう一方の言語で返るところまでは確認できます。双方向会話や話者別処理を確認する場合は、`ALLOWED_USER_IDS`へ追加した参加者がもう一人以上必要です。

## セットアップ

### 1. Discord Application を設定する

1. [Discord Developer Portal](https://discord.com/developers/applications)で対象の Application を開きます。
2. `Bot`画面で Bot Token を発行します。Token はチャットや Git へ貼らないでください。
3. 第三者が追加できないように、`Public Bot`を OFF にします。
4. `Installation`画面では、Installation Contexts を`Guild Install`だけにし、常設の Install Link を無効にします。
5. Application の所有者が OAuth2 URL Generator を一時的に使い、`bot`と`applications.commands`、次の Bot 権限だけを選んでテスト用サーバーへ追加します。生成した URL は配布しません。

   - View Channels
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Connect
   - Speak

6. Discord の`ユーザー設定 > 詳細設定 > 開発者モード`を ON にします。対象サーバーと利用者を右クリックし、Server ID と User ID をコピーします。

Bot は、実行時にもサーバーと全参加者を許可リストで検証します。自分一人で試す場合も、Server ID と自分の User ID が必要です。

### 2. 依存関係とローカル設定を用意する

```bash
pnpm install --frozen-lockfile
```

`.env.local`がまだない場合だけ、公開用テンプレートをコピーします。既存ファイルがある場合は、秘密値を失うため、このコピーを実行しないでください。

```bash
cp -n .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

最後のコマンドの出力を`LOG_ID_HMAC_KEY`へ設定します。続いて、次の項目を`.env.local`へ入力します。

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`
- `ALLOWED_GUILD_IDS`: カンマ区切りの Server ID
- `ALLOWED_USER_IDS`: カンマ区切りの User ID。発話する全員を含めます。

`.env.example`にある数値は、コード内の既定値ではなく配布時の初期値です。Bot は設定不足を起動時にエラーとして扱います。唯一、省略時のコード既定値を持つ項目は`SONIOX_TTS_SPEED=1.15`です。

ローカルで直接起動する場合は、SQLite の保存先を作り、表示された絶対パスを`SQLITE_PATH`へ設定します。

```bash
install -d -m 700 .data
realpath .data/usage.sqlite
```

Docker Compose では、`SQLITE_PATH`の設定にかかわらず、コンテナ内の`/data/usage.sqlite`を名前付きボリュームへ保存します。

翻訳用語を指定する場合は、例を Git 管理外のファイルへコピーし、その絶対パスを`TRANSLATION_TERMS_PATH`へ設定します。

```bash
cp config/translation-terms.example.json config/translation-terms.json
realpath config/translation-terms.json
```

用語を使わない場合は、`TRANSLATION_TERMS_PATH`を空欄のままにします。Docker Compose は空の用語集を読み取り専用でマウントします。

### 3. Soniox Project を設定する

1. [Soniox Console](https://console.soniox.com/)で、この Bot 専用の Project を作成します。
2. Project のリージョンと同じ値を`SONIOX_REGION`へ設定します。指定できる値は`us`、`eu`、`jp`です。
3. Project API Key を`SONIOX_API_KEY`へ設定します。
4. Soniox Console で Project の月額上限を決めます。同じ金額を microUSD へ換算し、`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`へ設定します。たとえば5 USDは`5000000` microUSDです。
5. 4段階の上限が、次の大小関係を満たすように設定します。

   ```text
   USER <= GUILD <= GLOBAL < SONIOX_PROJECT
   ```

6. [Soniox の公式料金表](https://soniox.com/pricing)で最新単価を確認します。`STT_COST_MICROUSD_PER_HOUR`、`TTS_COST_MICROUSD_PER_HOUR`、`TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND`を見直し、確認日を`PRICING_CONFIRMED_AT`へ設定してください。テキスト単価の上限は、`（100万トークン当たりのUSD単価）×4×1,000,000` microUSD/100万文字で求めます。ここでは、1文字当たり最大4トークンとして計算しています。料金が変わっていない場合も、日付だけを機械的に更新せず、実際に確認してから更新します。
7. 利用できる STT・TTS モデル、対応言語、voice を実 API で確認します。

```bash
pnpm soniox:inspect
```

出力された`stt_models`と`tts_models`に、設定するモデルが含まれることを確認します。TTS モデルでは、3言語と3つの`voice`設定も確認してください。`SONIOX_VOICE_JA`、`SONIOX_VOICE_KO`、`SONIOX_VOICE_EN`という設定名は互換性のために残しています。現在は言語別ではなく、参加者1〜3の音声枠です。3つの設定には、互いに異なる多言語 voice を指定してください。同じ参加者には、翻訳先言語が変わっても同じ voice を割り当てます。

### 4. 設定を検証する

```bash
pnpm config:check
```

`設定は有効です。Botを起動できます。`と表示されるまで、指摘された設定を修正してください。このコマンドは Token や API Key の値を表示しません。料金確認日が`PRICING_MAX_AGE_DAYS`を超えている場合も失敗するため、前の手順へ戻って単価と確認日を見直します。

起動時には、設定ファイルの形式だけでなく、Soniox のモデル・言語ペア・voice・速度・同時実行枠と、利用量照合の成功も確認します。これらを確認できない場合は Discord へ接続しません。

### 5. Slash Command を登録する

```bash
pnpm register-commands
```

許可したサーバーごとに`"event":"guild_commands_registered"`が1件出れば、登録は成功です。失敗した場合は、Application ID、Bot Token、対象サーバーへの追加状態を確認してから再実行します。

`/translate`は`ALLOWED_GUILD_IDS`にあるサーバーだけへ登録します。`default_member_permissions`は`0`なので、最初は管理者だけが利用できます。一般メンバーへ許可する場合は、Discord の`サーバー設定 > 連携サービス（Integrations） > 対象 Bot > /translate`で対象ロールまたは利用者を明示的に許可してください。Discord 側の権限とは別に、Bot は実行時のサーバー・利用者許可リストも検証します。

現在の登録スクリプトは、許可リストから削除したサーバーの既存コマンドを消しません。実行時には、そのサーバーからの操作を引き続き拒否します。コマンド表示も消す場合は、公開前に登録解除の運用を別途行ってください。

## 起動する

### Docker Compose

```bash
pnpm docker:up
pnpm docker:status
pnpm docker:logs
```

ログに`"event":"application_ready"`があれば、起動準備は完了です。設定や Soniox の事前確認に失敗した場合、Node.js のプロセスは Discord へ接続せずに終了します。ただし、Compose の`restart: unless-stopped`により、コンテナは再起動を繰り返します。

`application_ready`が出ず、`application_start_failed`が繰り返される場合は、`pnpm docker:logs`を確認します。`config_issues`、表示されている場合は`error_code`、最後に`error_name`を手掛かりにしてください。その後、`pnpm docker:down`で再起動を止めます。設定を修正し、`pnpm config:check`を通してから、もう一度`pnpm docker:up`を実行します。

停止する場合は、次を実行します。

```bash
pnpm docker:down
```

### Node.js

開発実行では TypeScript を直接起動できます。

```bash
pnpm dev
```

本番相当の JavaScript を起動する場合は、先にビルドします。

```bash
pnpm build
pnpm start
```

どちらの起動方法でも、`"event":"application_ready"`が出れば準備完了です。失敗時は、端末に出る`application_start_failed`の`config_issues`を確認します。表示されている場合は`error_code`も確認し、それらがない場合は`error_name`を手掛かりにします。

## 使い方

1. 許可された利用者全員が、同じ音声チャンネルへ参加します。
2. 字幕を表示してよい親テキストチャンネルで、`/translate start`を実行します。
3. `pair`で言語ペアを選びます。`mode`を省略すると会話優先になります。
4. 親チャンネルに表示されたカードからセッションを停止できます。また、音声再生の有無、再生モード、字幕送信失敗時の方針を変更できます。
5. 終了時はカードの停止ボタン、または`/translate stop`を使います。

カードを操作できるのは、開始者、対象音声チャンネルに現在参加している利用者、または`Manage Guild`権限を持つ利用者です。

字幕用スレッドは公開スレッドです。親チャンネルを閲覧できるメンバーは字幕も閲覧できます。音声と字幕を外部サービスと Discord へ送ることについて、参加者の同意を得たうえで、機密情報を話さないチャンネルで使用してください。スレッドは終了後にアーカイブされますが、自動削除はされません。

## 動作を確認する

一人で日韓翻訳を確認する場合は、次の順に進めます。

1. 起動ログに`"event":"application_ready"`があり、自分の User ID が`ALLOWED_USER_IDS`に含まれていることを確認します。
2. 音声チャンネルへ参加します。
3. `/translate start pair:日本語 ⇄ 韓国語 mode:会話優先`を実行します。
4. 普通の長さの日本語を話します。
5. 専用スレッドで仮字幕が更新され、確定字幕へ変わることを確認します。
6. 音声チャンネルで韓国語の読み上げが始まり、字幕の状態が`再生済み`へ変わることを確認します。
7. カードから字幕のみへ切り替え、以後の字幕は続く一方で音声が再生されないことを確認します。
8. 停止ボタンを押し、Bot が音声チャンネルから退出してカードが終了状態になることを確認します。

この手順では、次の項目を確認できません。

- 双方向の会話
- 複数人の発話分離
- 話者別の voice
- 他の言語ペア
- 長時間の継続運転

### 受入試験の証跡を残す

限定公開版の受入試験では、[設計書の第16章](./docs/design.md#16-限定公開の試用版に対する受入条件)にあるシナリオを実行し、試験前に合格基準を決めます。開始時と終了時に、コミット SHA、メモリ使用量、発話処理ログを記録してください。

次は、Docker Compose の配置を受入対象とする場合の採取例です。Node.js で直接起動する経路を受入対象にする場合は、次の証跡を、Compose 経路と同様に開始時と終了時に残す手順を試験前に定めてください。

- プロセスの管理方法
- 対象 PID のメモリ
- 標準出力ログ
- `SQLITE_PATH`から取得する利用量の集計

次の Compose 用コマンドは、Node.js の直接起動にはそのまま流用できません。

```bash
git status --porcelain=v1
git rev-parse HEAD
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' \
  "$(docker compose --env-file .env.local ps -q bot)"
docker compose --env-file .env.local logs --since=30m bot \
  | rg '"event":"(application_ready|translation_latency|translation_flow|translation_runtime_warning|translation_runtime_failed)"'
```

最初の`git status`で何も出力されないことを、受入試験を始める前提条件とします。差分が出た場合は、受入対象に含める変更をコミットしてから試験をやり直してください。

Compose で実行中の SQLite から、IDを含まない Global 集計だけを確認する場合は、次を使います。

```bash
docker compose --env-file .env.local exec -T bot \
  node --input-type=module - <<'NODE'
import Database from "better-sqlite3";

const database = new Database("/data/usage.sqlite", { readonly: true });
const row = database.prepare(`
  SELECT period, stt_stream_ms, tts_audio_ms, text_character_count,
         estimated_cost_microusd, reconciled_cost_microusd
  FROM monthly_usage
  WHERE scope_type = 'global' AND scope_id = 'global'
  ORDER BY period DESC
  LIMIT 1
`).get();
console.log(JSON.stringify(row));
database.close();
NODE
```

`reconciled_cost_microusd`は Soniox `usage logs`との照合額です。[Soniox Console](https://console.soniox.com/)の Project 利用量・請求額も同じ時点で記録し、ローカル見積額、照合額、実請求額を比較します。発話本文や生の Discord ID は証跡へ残さないでください。

## 運用とトラブルシューティング

### 翻訳が遅い

本文や Discord ID を出さず、区間時間と処理段階を確認できます。

```bash
docker compose --env-file .env.local logs --since=30m bot \
  | rg '"event":"(translation_latency|translation_flow)"'
```

同じ`trace_id`が1発話です。`playback_started.total_ms`は、最後の音声パケットを受信してから、Discord で再生を始めるまでの時間です。字幕投稿と TTS は並行するため、`caption_posted`と`playback_started`の順序は一定ではありません。

主な`translation_flow`は次のとおりです。

| stage | 意味 |
|---|---|
| `stt_manual_finalize_speaking_end` | Discord の発話終了を受けて、100 ms後に確定を要求した |
| `stt_manual_finalize_inactivity` | 認識内容が3秒進まなかったため、確定を要求した |
| `stt_manual_finalize_max_duration` | 発話長が`UTTERANCE_MAX_SOURCE_SECONDS`に達した |
| `voice_packet_dropped` | 破損した Opus パケットを1件だけ破棄した |
| `voice_startup_buffer_overflow` | STT 接続待ちの音声バッファが上限に達し、停止した |

### ログに実行時警告が出る

```bash
docker compose --env-file .env.local logs --since=30m bot \
  | rg '"event":"translation_runtime_warning"'
```

主な`translation_runtime_warning`と対処は次のとおりです。

| operation | 意味と対処 |
|---|---|
| `voice_receive_stream_recovering` | 200 ms後に受信ストリームを再購読する。繰り返す場合は Discord Voice の接続状態を確認する |
| `caption_preview`、`caption_post`、`caption_update`、`unsupported_language_warning` | 字幕の作成・更新に失敗した。スレッドの閲覧状態、Bot の送信権限、Discord の障害情報を確認する |
| `card_update`、`stop_notice`、`thread_archive` | カードや終了表示の更新に失敗した。Bot の権限を確認し、必要ならスレッドを手動でアーカイブする |

受信ストリームが`data`パケットを1件受け取ると、復旧回数は0に戻ります。1件も受け取れないまま復旧に4回連続で失敗した場合は、`VOICE_CONNECTION_LOST`でセッションを停止します。

### 環境音で発話が確定しない

扇風機などの環境音で Discord の発話表示が点灯し続ける場合は、Discord の`ユーザー設定 > 音声・ビデオ`で[Krisp](https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ)を有効にしてください。それでも続く場合は、[入力感度](https://support.discord.com/hc/en-us/articles/211376518-Voice-Input-Modes-101-Push-to-Talk-Voice-Activated)の自動判定を OFF にし、無発話時のノイズより高く、最も小さい声より低い位置に閾値を調整します。

Bot 側にも認識停滞3秒と発話長上限があるため、終了イベントが欠けても無期限には待ちません。

### Docker がブリッジネットワークを作れない

`failed to add the host ... veth ... operation not supported`が出るホストでは、明示的なホストネットワーク設定を使えます。

```bash
pnpm docker:host:up
pnpm docker:host:status
pnpm docker:host:logs
```

停止時は次を実行します。

```bash
pnpm docker:host:down
```

この Bot はポートを待ち受けませんが、ホストネットワークは Docker のネットワーク分離を弱めます。標準構成では使わず、ブリッジを作れないホストだけで使用してください。

## 開発と検証

通常の変更では、次を実行します。

```bash
pnpm check
pnpm build
pnpm smoke:runtime
pnpm audit --prod
pnpm diagrams:sync
git diff --exit-code -- docs/diagrams
```

Compose とイメージも確認する場合は、セットアップ済みの`.env.local`を使います。`config -q`は設定内容を表示せず、Bot も起動しません。次の`docker build`は、ローカルの Docker daemonを使う場合の例です。`.dockerignore`を修正するまでは、Git 管理外のブラウザー出力を持つ作業ツリーからリモートビルダーを使わないでください。

```bash
docker compose --env-file .env.local config -q
docker build --tag discord-translate:check .
```

`-q`を外した Compose の出力には、展開後の環境変数が含まれる可能性があります。実際の`.env.local`や展開結果を、検証ログへ出力しないでください。CI でも前記の検証を実行し、Compose 設定と Docker ビルドまで確認します。

## セキュリティとプライバシー

- `.env.local`、SQLite、実運用の翻訳用語ファイルは Git 管理外です。
- Docker のビルドコンテキストから、`.env`系の実設定、SQLite、`.data/`、`docs/`、`test/`、`node_modules/`、`output/`を除外しています。リポジトリ直下の Markdown 文書、`.playwright-cli/`、`coverage/`は除外していません。Dockerfile はこれらをイメージへ`COPY`しませんが、`.dockerignore`を直すまではリモートビルダーを使わないでください。
- Bot は Discord ID を HMAC で仮名化して記録し、ログへ発話本文、字幕本文、表示名、Token、API Key、例外メッセージを出しません。
- 字幕の Markdown をエスケープし、Discord のメンション展開を無効にしています。
- SQLite には利用量と運用メタデータを保存します。音声、字幕本文、表示名は保存しません。ただし、Discord の User ID、Guild ID、Channel ID は保存します。
- Soniox への接続先は`us`、`eu`、`jp`に対応する固定 HTTPS・WSS エンドポイントだけです。Project のリージョンと API Key を一致させてください。
- セッションを終了しても、Discord の公開スレッドと字幕メッセージは削除しません。必要に応じて Discord 側で削除してください。

現時点の公開前調査では、追跡中ファイルと Git 履歴に実 API Key や Bot Token は検出されず、本番向けの依存関係にある既知脆弱性も0件でした。ただし、自動検出には限界があり、秘密情報や個人情報を見逃す可能性があります。公開直前に、[security_best_practices_report.md](./security_best_practices_report.md)の未解決事項と手動確認項目を再確認してください。
