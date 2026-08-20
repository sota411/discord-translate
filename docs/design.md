# Discord Realtime Translation Bot 設計書

本書は、Discordの音声チャンネルで日本語・韓国語・英語を双方向に翻訳するBotの現行設計を示す。基準日は2026年8月20日。コード、自動テスト、配布設定、運用ファイルを照合し、実装済みと未検証を分けて記載する。

導入手順は[README](../README.md)、公開前の安全性調査は[公開前セキュリティ監査](../security_best_practices_report.md)を参照する。一般公開前の未解決事項は第14節にまとめる。

| 表記 | 意味 |
|---|---|
| 実装済み | 現行コードに処理がある |
| 自動確認済み | 現行コードに対する自動検証が成功した |
| 実機確認済み | Discord・Sonioxの実サービスで確認した履歴がある |
| 未検証 | 実装済みだが、現行版を実サービスで確認していない |
| 未実装 | 必要性はあるが、現行コードに処理がない |
| Guild | Discord API上のサーバー |
| STT | 音声認識とテキスト化。Sonioxでは翻訳も同じ処理で行う |
| TTS | テキストから読み上げ音声を生成する処理 |
| E2E | DiscordからSonioxを経てDiscordへ戻る経路の実サービス確認 |

## 1. 対象は1〜3人の限定公開

言語の異なる1〜3人が同じ音声チャンネルで会話するとき、発話を選択した言語ペアのもう一方へ翻訳する。原文と翻訳文を字幕として表示し、翻訳音声を同じ音声チャンネルへ出力する。運営者が費用、利用者、保存データを制御できる小規模運用を前提とする。

### 対象

- 言語ペアは`ja-ko`、`ja-en`、`ko-en`
- 1セッションの人間参加者は1〜3人。配布初期値は2人
- 同じGuildでは同時に1セッション
- 発話者ごとにSTTストリームとvoiceを分離
- 仮字幕と確定字幕を専用の公開スレッドへ表示
- 確定翻訳だけをTTSへ送り、確定順に再生
- 会話優先と正確さ優先の2モード
- User・Guild・Globalの月間利用上限と、Soniox Project上限の手前に置くローカル上限
- 音声、字幕本文、表示名をBotの永続ストレージとログへ保存しない

### 対象外

- 不特定多数が追加できる公開Bot
- 4人以上、3言語以上、または日韓英以外の会話
- 音声録音、字幕検索、会話履歴
- 話者の自動登録、課金、管理画面
- 非公開スレッドやDMへの字幕配信
- 完全な同時通訳、または再生開始300 ms以内の保証

## 2. 現行版は自動検証済み、実サービスE2Eは未完了

### 自動確認済み

現行環境では次が成功している。

- ESLintとTypeScript型検査
- 公開境界・統合テスト148件
- 本番用ビルド
- `better-sqlite3`と`@discordjs/opus`の実行検査
- 本番向け依存関係の監査
- Compose設定検証とDockerビルド
- 図版のHTML・SVG同期

CIも同じ検査を実行する。

### 実機確認の履歴

以前のUIを使った版では、Discord・Sonioxの実サービスで、参加者1人による日本語・韓国語の通話、字幕、読み上げを確認した。8発話の区間遅延も計測した。発話中に確定トークンをTTSへ送る実験は、ストリーム終端とキャンセルが不安定だったため現行版へ採用していない。

この履歴は現行版の受入証跡ではない。当時は次を確認していない。

- セッションカード
- 専用スレッド
- 仮字幕
- 2つの再生モード
- 話者別voice

### 未検証

- 現行版のDiscord・Soniox E2E
- 2人・3人通話、日英、韓英
- 3言語ペアの30分継続運転
- 実請求額とローカル台帳の照合精度
- 複数Guildの同時運転
- Discord DAVE（音声のエンドツーエンド暗号化）環境での受信ストリーム復旧
- 実デプロイ環境のGitHub Actions

## 3. 利用者はコマンドとセッションカードを操作する

### コマンド

| コマンド | 引数 | 動作 |
|---|---|---|
| `/translate start` | `pair`必須、`mode`任意 | 実行者が参加中の音声チャンネルで開始 |
| `/translate stop` | なし | 実行中のセッションを停止 |

`pair`は3言語ペアから選ぶ。`mode`を省略した場合は`conversation`になる。コマンドはGuild内だけで使え、`default_member_permissions`は`0`。Discord側では管理者または明示的に許可された利用者だけが実行できる。

### 開始条件

`/translate start`は次の順に検査する。

1. コマンドがGuild内で実行されている
2. Guildが`ALLOWED_GUILD_IDS`に含まれる
3. 実行者が`ALLOWED_USER_IDS`に含まれる
4. 実行者が音声チャンネルへ参加している
5. 全人間参加者が許可されている
6. 人間参加者が`MAX_SPEAKERS_PER_SESSION`以下である
7. Botが必要な音声・テキスト・公開スレッド権限を持つ
8. 同じGuildに開始中または実行中のセッションがない
9. User・Guild・Globalの利用額が上限内で、利用量照合が古くない
10. SonioxのProjectとOrganizationに、設定上限人数分のSTTと1本のTTSの空きがある

Sonioxの容量は、現在の参加者数ではなく`MAX_SPEAKERS_PER_SESSION`本のSTTを予約できる前提で判定する。開始後に参加者が増えた場合も、追加利用者の月間上限を検査する。

### カードと字幕

開始に成功すると、Botは親テキストチャンネルへセッションカードを投稿する。そのカードから公開スレッドを作り、仮字幕と確定字幕をスレッドへ投稿する。

カードには言語ペア、参加者、経過時間、音声の待ち時間、再生モード、実行状態を表示する。カードから次を操作できる。

- セッションの停止
- 音声再生と字幕のみの切り替え
- 会話優先と正確さ優先の切り替え
- 字幕の新規投稿に失敗したとき、音声を継続するか停止するか

操作できるのは、開始者、対象音声チャンネルの現在参加者、または`Manage Guild`権限を持つ利用者。カードのSession IDが現行セッションと一致しない場合は、終了済みとして拒否する。

公開スレッドは親チャンネルの閲覧者からも見える。終了時にアーカイブするが、自動削除しない。

### 参加者の変化

| 変化 | 動作 |
|---|---|
| 未許可の人間が入室 | `SPEAKER_NOT_ALLOWED`で停止 |
| 設定人数を超過 | `TOO_MANY_SPEAKERS`で停止 |
| 人間参加者が0人 | `VOICE_EMPTY`で停止 |
| Botが対象音声チャンネルから外れる | `BOT_VOICE_REMOVED`で停止 |
| 許可された利用者が増える | 月間上限を検査してストリームを追加 |

## 4. DiscordとSonioxへ外向きに接続する

![Discord、Bot、Sonioxのシステム構成](./diagrams/system-architecture.svg)

[HTML版を開く](./diagrams/system-architecture.html)

BotはHTTPサーバーを持たない。Discord Gateway・Voice、およびリージョンごとに固定したSonioxのHTTPS・WSSエンドポイントへ外向きに接続する。

### 起動順

1. 環境変数を検証する
2. 翻訳用語を読み込む
3. SQLiteを開き、スキーマを作成または確認する
4. 異常終了で残ったセッションとプロバイダー要求を失敗扱いにする
5. 保持期限を過ぎた利用量を削除する
6. Sonioxのモデル、3言語、3言語ペア、voice、無音短縮、速度を検査する
7. Sonioxの同時実行枠APIを検査する
8. Soniox `usage logs`とローカル台帳を照合する
9. Discord Gatewayへ接続する
10. 定期照合タイマーを開始する

手順1〜8のいずれかが失敗すると、Discordへ接続しない。設定不備や課金制御の異常、外部仕様とのずれを検出し、利用開始を止める。

### 主要コンポーネント

| コンポーネント | 責務 | 主な実装 |
|---|---|---|
| 設定 | 環境変数、リージョン、上限、パスを起動時に検証 | `src/config.ts` |
| Command Service | Guild・利用者・参加者・権限を認可 | `src/commands/translation-command-service.ts` |
| Session Manager | Guildごとの単一セッションと状態を管理 | `src/session/session-manager.ts` |
| Discord Driver | Voice受信、STT、字幕、再生、復旧を統合 | `src/discord/translation-driver.ts` |
| Utterance Processor | 発話確定後の字幕、TTS、FIFO、割り込みを管理 | `src/translation/utterance-processor.ts` |
| Soniox Control | モデル・容量の事前確認、STT作成、利用量照合 | `src/soniox/control.ts` |
| TTS Gateway | 常時接続WebSocketとストリームを管理 | `src/soniox/raw-tts-gateway.ts` |
| Usage Ledger | 利用量、見積額、照合額、保持期限をSQLiteで管理 | `src/usage/usage-ledger.ts` |
| Safe Logger | IDを仮名化し、内容を含まないJSONログを出力 | `src/observability/logger.ts` |

### 既存ライブラリを優先する

- Discord Gateway、Application Command、Components V2、Voice、権限判定は`discord.js`と`@discordjs/voice`を使う
- Soniox STT、モデル、利用量、同時実行枠は公式`@soniox/node`を使う
- 入力と外部応答はZodで検証する
- 永続化は`better-sqlite3`とSQLiteの制約・トランザクションを使う
- HMAC、UUID、AbortSignal、ストリームはNode.js標準機能を使う

公式`@soniox/node` 2.3.0のRealtime TTSは、速度、無音短縮、明示終了、キャンセルを提供する。ただし、Realtime TTSのストリーム設定には`client_reference_id`がない。現行版はTTSの利用量もSoniox `usage logs`と照合するため、このIDを送れるraw WebSocketを採用済みの`ws`で実装する。接続先はリージョンごとの固定URLとし、受信イベントをZodで検証する。

## 5. セッション開始処理の失敗は`FAILED`、実行時障害は`STOPPING`を経由する

![翻訳セッションの状態遷移](./diagrams/session-state.svg)

[HTML版を開く](./diagrams/session-state.html)

セッションが存在しない状態は、`SessionManager`の`Map`にエントリがないことで表す。列挙型は次の5値を持つ。

| 状態 | 意味 |
|---|---|
| `AUTHORIZING` | ローカル利用上限とSoniox同時実行枠を確認中 |
| `CONNECTING` | Discordチャンネル再確認、台帳作成、Voice接続、カード・スレッド作成中 |
| `ACTIVE` | 発話を受信し、翻訳できる |
| `FAILED` | 開始処理が失敗し、エントリを除去する直前 |
| `STOPPING` | 開始中断または実行中セッションの停止処理中 |

コマンド前段の認可、参加者、権限、言語ペアの拒否は、セッションを作らずに返す。`SessionManager.start`の重複検査も、エントリを作る前に拒否する。

エントリ作成後は、セッションなし→`AUTHORIZING`→`CONNECTING`→`ACTIVE`→`STOPPING`→セッションなしと進む。利用量・容量検査または接続・提示準備に失敗すると、`FAILED`を経てエントリを除去する。開始中に停止すると一時的に`STOPPING`となり、開始処理の例外処理で`FAILED`を経由する。`ACTIVE`中の復旧不能な障害は`STOPPING`へ直接進む。

Global上限またはSoniox 402を検出しても、現行実装が停止するのは検出したGuildのセッションだけ。別Guildの実行中セッションは止まらない。

## 6. 発話境界の確定後に字幕とTTSを並行処理する

![1発話を字幕と翻訳音声へ変えるシーケンス](./diagrams/utterance-sequence.svg)

[HTML版を開く](./diagrams/utterance-sequence.html)

### 音声受信

Discordの発話開始イベントを受けると、再生割り込みを判定し、TTS接続を先にウォームアップする。その後、発話者別のOpusパケットを購読し、48 kHz・16 bit・stereo PCMへ復号する。mono PCMへ変換してSoniox STTへ送る。STT接続前の音声は、250パケットまたは512 KiBの先に達した方まで保持する。超過時は音声を欠落させず、セッションを停止する。

破損したOpusパケットは1件だけ破棄する。受信ストリームが`close`した場合は200 ms後に再購読する。再購読後に`data`を1件受け取ると復旧回数を0に戻す。再購読後もデータを受信できない状態が4回続くと停止する。復号、パケット解析、STT送信のエラーは`SONIOX_STREAM_FAILED`で停止する。

### STTと発話境界

発話者ごとのSTTには次を指定する。

- 48 kHz・16 bit・mono PCM
- 選択した2言語と言語識別
- semantic endpoint
- 双方向翻訳
- 任意の翻訳用語

トークンは`is_final`、`translation_status`、`language`、`source_language`を検査して組み立てる。未確定トークンはTTSへ送らず、確定済みトークンと合わせて仮字幕へ表示する。仮字幕は発話者ごとに最大500 ms間隔で更新する。言語ペア外の言語を検出した場合は翻訳せず、スレッドへ英語の警告を出す。

| 確定経路 | 条件 |
|---|---|
| semantic endpoint | Sonioxが`endpoint`を返す |
| manual finalize | Discordの発話終了から100 ms後に、200 ms分の無音PCMとfinalizeを送る |
| inactivity | STTの認識結果が3秒間更新されない |
| maximum duration | 認識開始から`UTTERANCE_MAX_SOURCE_SECONDS`に達した |

`endpoint`または`finalized`を1発話の境界とする。確定済みの原文と翻訳文が揃った発話だけを後段へ渡す。空の発話は仮字幕を削除して終える。

### 字幕、TTS、再生

境界の確定後、確定字幕の投稿とTTS生成を並行して始める。字幕投稿の完了は音声再生の条件にしない。

TTS WebSocketへの接続だけを発話開始時に先行させる。API Keyを含む設定、翻訳本文、`text_end`は境界確定後に送る。TTS応答はZodで検証し、1メッセージを8 MiB以下に制限する。生成時には次を指定する。

- モデルと翻訳先言語
- 話者のvoice
- 48 kHz PCM、速度、無音短縮
- 不透明な要求ID

再生順は発話確定順のFIFO。先行発話の再生中は後続1発話までTTSを準備する。待機音声は48 kHz mono PCMの120秒相当までメモリへ保持する。

| モード | 待ち時間が2.5秒を超えた | 新しい発話が始まった |
|---|---|---|
| `conversation` | 待機中の翻訳音声を省略 | 再生中・待機中・生成中の翻訳音声を中断 |
| `accuracy` | FIFOを維持し、カードへ遅延警告を表示 | 中断しない |

字幕のみに切り替えると、再生中・待機中・生成中のTTSを止める。以後は字幕だけを投稿する。

`PLAYBACK_QUEUE_MAX_MS`は既存配置との互換性のために必須の設定項目として残る。現行処理は停止条件にも2.5秒の判定にも使わない。

### 字幕失敗

初期設定は`continue_audio`である。仮字幕または確定字幕の新規投稿に失敗した場合、`continue_audio`では警告を記録して音声を続ける。`stop_session`では`CAPTION_SEND_FAILED`で停止する。既存字幕の編集や削除の失敗は、どちらの方針でも停止条件にならない。

## 7. SQLiteは利用量だけを保持する

SQLiteはWAL modeで開く。親ディレクトリを新規作成した場合は`0700`、DBファイルは既存・新規を問わず`0600`へ設定する。既存の親ディレクトリ権限は変更しない。

| テーブル | 主な内容 |
|---|---|
| `session_usage` | Session ID、Guild・Voice Channel・Text Channel・開始者ID、言語ペア、時刻、終了理由、見積額・照合額 |
| `provider_request` | Provider Request ID、Session ID、User ID、STT/TTS、状態、利用時間、文字数、見積額・照合額 |
| `monthly_usage` | User・Guild・Globalごとの月、利用時間、文字数、見積額・照合額 |
| `app_meta` | 最終照合時刻と書き込み確認 |

音声、原文、翻訳文、表示名は保存しない。Discord IDは運用メタデータとして保存する。

起動時に未完了の`provider_request`を`failed`へ変更し、未完了の`session_usage`を`PROCESS_RESTART`で終了する。User・Guildの月次集計は当月と前月、Globalは当月を含む12か月を保持する。古いセッションを削除すると、紐づくプロバイダー要求も削除する。

Discordのスレッドと字幕はSQLiteの保持処理に含まれない。終了時にアーカイブするが、削除しない。

## 8. 利用量はローカル見積額とSoniox照合額の大きい方で判定する

ローカル見積額は、STTストリーム時間、TTS音声時間、課金対象テキストの文字数から計算する。設定単価と安全係数を掛け、microUSDの整数に切り上げる。上限判定には、ローカル見積額とSoniox `usage logs`の照合額の大きい方を使う。

設定は次の大小関係を満たす必要がある。

```text
User <= Guild <= Global < Soniox Project budget
```

User上限は新規参加、Guild上限は新規セッション、Global上限は全Guildの新規セッションを拒否する。上限判定後に発生した利用量も台帳へ加算する。

起動時とセッション終了時に`usage logs`を取得する。配布初期値では60秒ごとにも取得する。ローカルのProvider Request IDを`client_reference_id`へ対応させ、Sonioxの`cost_usd`を照合額として記録する。最終照合から180秒を超えると、新規セッションと新規参加者を拒否する。

`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`は、Consoleに設定したProject上限を転記した値である。BotはConsoleの設定を変更せず、Console上の実際の設定値との一致も自動確認しない。

| Soniox応答 | Botの分類 |
|---|---|
| 401・403 | 認証失敗 |
| 402 | 予算到達 |
| 429 | 同時実行上限 |
| その他のストリームエラー | プロバイダー障害 |

### 現行の予算制御には競合が残る

複数Guildが同時に開始・課金すると、事前判定を両方通過してGlobal上限を超過できる。Global上限またはSoniox 402を1つのGuildで検出しても、停止するのはそのGuildだけ。別Guildの実行中セッションを一括停止する処理は未実装である。

したがって、`GLOBAL_MONTHLY_COST_LIMIT_MICROUSD`はプロセス全体の即時停止機能ではない。利用範囲を広げる前に、原子的な予算予約またはプロセス全体の同時1セッション制限が必要になる。

## 9. `.env.example`は配布初期値を持つ

### 秘密値と許可リスト

| 設定 | 配布初期値 | 制約 |
|---|---:|---|
| `DISCORD_TOKEN` | 空 | 必須、Git管理外 |
| `DISCORD_APPLICATION_ID` | 空 | 17〜20桁 |
| `ALLOWED_GUILD_IDS` | 空 | 17〜20桁のIDを1件以上 |
| `ALLOWED_USER_IDS` | 空 | 17〜20桁のIDを1件以上。全発話者を含める |
| `SONIOX_API_KEY` | 空 | 必須、Bot専用Project |
| `LOG_ID_HMAC_KEY` | 空 | 32文字以上、他用途と共有しない |

### セッション

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `SESSION_MAX_MINUTES` | `30` | セッション最大時間 |
| `MAX_SPEAKERS_PER_SESSION` | `2` | 最大参加者。許容範囲は1〜3 |
| `SESSION_IDLE_TIMEOUT_SECONDS` | `120` | 人間の音声パケットがない場合の停止時間 |
| `PLAYBACK_QUEUE_MAX_MS` | `10000` | 互換性のために残る必須値。実行時判定には未使用 |
| `UTTERANCE_MAX_SOURCE_SECONDS` | `30` | 1発話の認識開始から確定までの上限 |
| `TTS_MAX_INPUT_CHARACTERS` | `300` | 1発話の翻訳本文上限 |
| `VOICE_RECONNECT_TIMEOUT_MS` | `5000` | Discord Voice再接続待ち |
| `SONIOX_TERMINATION_TIMEOUT_MS` | `5000` | TTSストリーム終了待ち |

### 利用上限と照合

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `USER_MONTHLY_COST_LIMIT_MICROUSD` | `1000000` | User月間上限 |
| `GUILD_MONTHLY_COST_LIMIT_MICROUSD` | `3000000` | Guild月間上限 |
| `GLOBAL_MONTHLY_COST_LIMIT_MICROUSD` | `4000000` | Bot全体の月間上限 |
| `SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD` | `5000000` | ConsoleのProject上限を写す値 |
| `STT_COST_MICROUSD_PER_HOUR` | `120000` | STT時間単価 |
| `TTS_COST_MICROUSD_PER_HOUR` | `700000` | TTS音声時間単価 |
| `TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND` | `16000000` | テキストの保守的な文字単価上限 |
| `COST_ESTIMATE_SAFETY_PERCENT` | `125` | 見積額の安全係数 |
| `PRICING_CONFIRMED_AT` | `2026-08-15` | 単価を一次情報で確認した日 |
| `PRICING_MAX_AGE_DAYS` | `30` | 単価確認日の有効期間 |
| `USAGE_RECONCILE_INTERVAL_SECONDS` | `60` | 定期照合間隔 |
| `USAGE_RECONCILE_MAX_STALENESS_SECONDS` | `180` | 新規開始を拒否する照合経過時間 |
| `SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS` | `30` | Soniox control APIのタイムアウト |

料金確認日が未来の日付、不正な日付、または有効期限切れの場合は起動を拒否する。料金を確認したら、単価と`PRICING_CONFIRMED_AT`を更新する。

### Sonioxと保存先

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `SONIOX_REGION` | `us` | `us`、`eu`、`jp`の固定エンドポイントを選択 |
| `SONIOX_STT_MODEL` | `stt-rt-v5` | STTモデル |
| `SONIOX_TTS_MODEL` | `tts-rt-v2` | TTSモデル |
| `SONIOX_TTS_SPEED` | `1.15` | 0.7〜1.3。省略時も1.15 |
| `SONIOX_VOICE_JA` | `Kenji` | 話者枠1の多言語voice |
| `SONIOX_VOICE_KO` | `Mina` | 話者枠2の多言語voice |
| `SONIOX_VOICE_EN` | `Emma` | 話者枠3の多言語voice |
| `TRANSLATION_TERMS_PATH` | 空 | 任意。指定時は絶対パス |
| `SQLITE_PATH` | `/data/usage.sqlite` | 必須の絶対パス |

3つのvoiceは重複できない。用語ファイルは3言語ペアを持つ厳格なJSONとする。同じ言語ペア内で`source`を重複できず、各言語ペアのJSON表現は10,000文字以下とする。

## 10. 信頼境界ごとに入力と出力を制限する

| 境界 | 制御 |
|---|---|
| Discord利用者→Bot | Guild・User許可リスト、Guild限定コマンド、Discord権限、Session ID、操作権限 |
| Discord Voice→音声処理 | 対象VC、Bot以外の参加者、最大人数、Opus復号、上限付き起動バッファ |
| Soniox→Bot | 固定HTTPS・WSS、TLS、SDK型、Zodスキーマ、タイムアウト、ペイロード上限 |
| Bot→Discordテキスト | Markdownエスケープ、メンション無効化、4,000文字上限、公開スレッド権限 |
| Bot→SQLite | プリペアドステートメント、スキーマ制約、WAL、権限`0700`・`0600` |
| 運用者→設定 | `.env.local`と実運用の翻訳用語ファイルをGit・Dockerコンテキストから除外し、起動時に検証 |

Discord Token、Soniox API Key、HMAC keyは環境変数から読む。Botの実行ログと起動・終了時の致命的エラーログは、例外メッセージとスタックを出さず、公開用のエラーコードまたはエラー名を記録する。環境変数の検証エラーも設定名と理由だけを出す。

`pnpm config:check`は運用者向けの診断コマンドであり、通常の`Error.message`を端末へ出す。不正な翻訳用語ファイルを指定した場合は、ファイルパスや重複した`source`を表示する。この出力を公開ログや問い合わせ先へ貼らない。

Guild・User IDはHMAC-SHA-256で仮名化し、先頭20桁の16進表現をログへ記録する。発話本文、字幕本文、表示名、Token、API Keyは記録しない。Session IDとProvider Request IDは、不透明な追跡IDとして使う。

### 利用範囲を広げる前にプライバシー条件を決める

- 公開スレッドは親チャンネルの閲覧者から見える
- 字幕はDiscordへ残り、自動削除されない
- SQLiteは生のDiscord IDとChannel IDを一定期間保存する
- 音声と翻訳内容をDiscordとSonioxへ送る同意を、Botは強制取得しない
- 用語ファイルの内容はSTTコンテキストとしてSonioxへ送る

運用規約には、参加同意、字幕の閲覧範囲、字幕と保存データの削除、保存期間、問い合わせ窓口を定める。

## 11. 障害は固定コードへ変換し、JSONログで追跡する

| 分類 | 例 | 動作 |
|---|---|---|
| 認可 | 未許可Guild・User | 開始を拒否 |
| 参加者 | 未許可、人数超過、無人 | セッションを停止 |
| Discord権限 | Voice・Text・Thread権限不足 | 開始を拒否し、不足権限名を返す |
| 利用量 | User・Guild・Global上限、照合期限切れ | 開始または参加を拒否し、検出Guildを停止 |
| Soniox | 認証、予算、同時実行枠、ストリーム障害 | 公開コードへ変換し、検出Guildを停止 |
| Discord Voice | Bot退出、再接続失敗、受信復旧失敗 | セッションを停止 |
| 発話 | 原音声長、TTS文字数、待機音声上限 | 対象コードで停止 |
| 字幕 | 新規投稿失敗 | 設定に従って音声継続または停止 |
| プロセス | SIGINT・SIGTERM | 新規コマンドを拒否し、使用中の資源を順に閉じる |

公開メッセージに内部例外や認証情報を含めない。カードの終了理由には固定コードを付ける。

ログはJSONとして1行に1件ずつ出力する。主なイベントは次のとおり。

| イベント | 用途 |
|---|---|
| `application_ready` | Discord接続と起動準備の完了 |
| `startup_recovery_complete` | 異常終了から復旧した件数 |
| `usage_retention_complete` | 保持期限で削除した件数 |
| `soniox_preflight_complete` | Sonioxの起動前確認完了 |
| `translation_flow` | 本文を含まない処理段階 |
| `translation_latency` | 1発話の区間時間 |
| `translation_runtime_warning` | 局所復旧や字幕編集失敗 |
| `translation_runtime_failed` | セッション停止へ至った障害 |
| `usage_reconciliation_failed` | 定期照合の失敗 |
| `application_shutdown_complete` | 正常終了処理の完了 |

`translation_latency.trace_id`は1発話を表す。`playback_started.total_ms`は最後の音声パケットから再生開始までの時間。字幕投稿とTTSは並行するため、イベント順は一定にならない。

## 12. Docker Composeを標準の配置経路とする

Dockerfileはビルド用と実行用を分ける。実行用ステージはNode 24.17.0の`node`利用者で動き、`/data`だけを永続ボリュームとする。Botは待受ポートを持たない。

Composeは`.env.local`を渡し、SQLiteを名前付きボリュームへ保存し、翻訳用語を読み取り専用でマウントする。`init: true`、`restart: unless-stopped`、30秒の停止猶予を設定する。

Compose設定の検査には`docker compose --env-file .env.local config -q`を使う。`-q`を外すと展開後の秘密値が表示されるため、出力を保存または共有しない。

ブリッジネットワークを作れないホストでは`compose.host.yaml`を使える。ホストネットワークは分離を弱めるため、標準構成にしない。

`pnpm register-commands`は`ALLOWED_GUILD_IDS`の各Guildへ`/translate`をPUTする。許可リストから削除したGuildの既存コマンドは削除しない。実行時認可は維持するが、古いコマンド表示が残る場合がある。

SIGINTまたはSIGTERMを受けると、新規コマンドを拒否して全Guildのセッションを停止する。必須の利用量照合を待ち、Discordリスナーとクライアント、TTS WebSocket、SQLiteを閉じる。

## 13. 受入は実サービスの証跡で判定する

現行版の受入には、少なくとも次の実サービス確認が必要になる。

1. 未許可Guild・User、未許可参加者、人数超過、権限不足を拒否する
2. 3言語ペアの両方向で、事前に決めた発話例の字幕と読み上げが合格基準を満たす
3. 1〜3人でvoiceが入れ替わらず、別利用者のストリームと混ざらない
4. 仮字幕が同じメッセージの確定字幕へ変わる
5. 会話優先モードでは、待ち時間が2.5秒を超えた音声を省略し、新しい発話が始まると古い翻訳音声を中断する
6. 正確さ優先モードでは、FIFOを保ち、遅延警告を表示する
7. 字幕のみに切り替えると、音声処理を止めて字幕を続ける
8. 破損したOpusパケットを局所的に破棄し、受信ストリームを再購読した後も処理を継続できる
9. User・Guild・Global上限とSoniox Project上限が新規利用を定義どおり拒否する
10. 正常終了と再起動後の台帳状態が正しい
11. 30分運転のメモリ、待ち時間、字幕、利用量、実請求額が事前基準を満たす

翻訳品質、遅延、メモリ増加量、ローカル台帳と実請求額の差には、まだ合格閾値がない。運営者が試験前に閾値を決める。結果を見た後に基準を変えない。閾値がない項目は受入済みにできない。

| 対象 | 残す証跡 |
|---|---|
| 試験条件 | 日時、コミットSHA、DiscordとSonioxのリージョン、Sonioxのモデル、秘密値を除いた設定 |
| 機能 | 3言語ペア・2モード・1〜3人のシナリオ別結果、失敗時の再現手順 |
| 遅延 | `translation_latency`から集計した区間値、事前の合格閾値 |
| 利用量・費用 | SQLite集計、Soniox `usage logs`、実請求額の比較 |
| 継続運転 | 30分のメモリ、再接続、字幕失敗、待ち時間 |

証跡にToken、API Key、発話本文、生のDiscord IDを含めない。字幕や録音を残す場合は、参加者の同意と保管・削除方法を先に決める。

## 14. 公開前に未解決事項を閉じる

### Botの利用範囲を広げる前

1. 複数Guildの同時課金でGlobal上限を超過できる競合を解消する
2. 現行版E2E、複数人、30分運転、利用額照合を完了する
3. 参加同意、字幕公開範囲、削除、保存期間、問い合わせ窓口を定める
4. `ManageThreads`を外した最小権限で、必要なスレッド操作を実機確認する

### リポジトリを一般公開する前

1. `discord_realtime_translation_chat.zip`と`docs/reference/design-structure-sample.md`を所有者が全文確認し、内容、権利、公開意図を承認する
2. LICENSE、問い合わせ先、`SECURITY.md`、脆弱性報告窓口を用意する
3. `.dockerignore`へ`.playwright-cli/`と`coverage/`を追加する
4. 最終コミットとGit履歴を秘密情報、依存関係、コンテナイメージの観点から再検査する
5. [公開前セキュリティ監査](../security_best_practices_report.md)の未解決事項を再判定する

### 実装判断が残る項目

1. 原子的な予算予約か、プロセス全体の同時1セッション制限か
2. Global上限またはSoniox 402で全Guildを即時停止するか
3. 許可リストから外したGuildのコマンドを削除する運用またはCLI
4. 非公開スレッドへの変更、または終了時の字幕削除
5. SQLiteに保存するDiscord IDの保持期間

## 15. 一次情報

### Soniox

- [Real-time speech-to-speech translation](https://soniox.com/docs/translation/sts-translation)
- [STT WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)
- [Real-time transcription tokens](https://soniox.com/docs/stt/rt/real-time-transcription)
- [Endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection)
- [Manual finalization](https://soniox.com/docs/stt/rt/manual-finalization)
- [TTS WebSocket API](https://soniox.com/docs/api-reference/tts/websocket-api)
- [TTS connection keepalive](https://soniox.com/docs/tts/rt/connection-keepalive)
- [TTS limits and quotas](https://soniox.com/docs/tts/rt/limits-and-quotas)
- [Supported translation languages](https://soniox.com/docs/translation/supported-languages)
- [Usage logs](https://soniox.com/docs/guides/usage-logs)
- [Concurrency limits](https://soniox.com/docs/guides/concurrency-limits)
- [API pricing](https://soniox.com/pricing)
- [API errors](https://soniox.com/docs/api-reference/errors)
- [Data residency](https://soniox.com/docs/data-residency)
- [Security and privacy](https://soniox.com/docs/security-and-privacy)

### Discord

- [Voice Connections](https://docs.discord.com/developers/topics/voice-connections)
- [Application Commands](https://docs.discord.com/developers/interactions/application-commands)
- [Threads](https://docs.discord.com/developers/topics/threads)
- [Message Components](https://docs.discord.com/developers/components/reference)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
- [Application installation contexts and links](https://docs.discord.com/developers/resources/application)
- [discord.js voice](https://discord.js.org/docs/packages/voice/0.19.2)
