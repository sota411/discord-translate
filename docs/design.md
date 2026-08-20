# Discord Realtime Translation Bot 設計書

## 1. この文書の位置づけ

この文書は、Discord の音声チャンネルで日本語・韓国語・英語を双方向に翻訳する Bot の現行設計を説明します。2026年8月20日時点のコードと自動テストを確認し、配布設定と運用ファイルも照合しました。その結果に基づき、実装済みの振る舞いと未検証事項を分けて記載しています。

利用者向けの導入手順は[README.md](../README.md)、公開前の安全性調査は[security_best_practices_report.md](../security_best_practices_report.md)を参照してください。

文中では、次の言葉を使い分けます。

| 表記 | 意味 |
|---|---|
| 実装済み | 現行コードに処理が存在する |
| 自動確認済み | 現行コードに対して、該当する自動検証が成功している |
| 実機確認済み | 実際の Discord・Soniox 環境で確認した履歴がある |
| 未検証 | 実装済みでも、現行版の実サービス環境では確認していない |
| 未実装 | 設計上の必要性はあるが、現行コードに処理がない |
| Guild | Discord API でサーバーを表す名称 |
| STT | 音声認識とテキストへの変換。Soniox では翻訳も同じ処理で行う |
| TTS | テキストから読み上げ音声を生成する処理 |
| E2E | Discord から Soniox を経て Discord へ戻るまでを実サービスで通す確認 |

## 2. 目的と範囲

### 2.1 目的

言語の異なる1〜3人が同じ Discord 音声チャンネルで会話するときに、発話を、選択した言語ペアのもう一方の言語で読み上げます。原文と翻訳文は字幕として残します。対象は、運営者が費用・利用者・保存データを制御できる小規模な限定公開の試用版です。

### 2.2 MVP の範囲

- 言語ペアは`ja-ko`、`ja-en`、`ko-en`です。
- 1セッションの人間参加者は1〜3人です。配布設定の初期値は2人です。
- 同じ Guild では、同時に1セッションだけ実行します。
- 発話者ごとに STT ストリームと voice を分けます。
- 仮字幕と確定字幕を、セッション専用の公開スレッドへ表示します。
- 確定した翻訳だけを TTS へ送り、同じ音声チャンネルで再生します。
- 会話優先と正確さ優先の2つの再生モードを提供します。
- User・Guild・Global の月間利用上限と、Soniox Project 上限の手前に置くローカル上限を設定します。
- 音声・字幕本文・表示名を、Bot の永続ストレージとログへ保存しません。

### 2.3 対象外

- 不特定多数が自由に追加できる公開 Bot
- 4人以上の同時通話
- 3言語以上を同時に扱う会話
- 日本語・韓国語・英語以外の言語ペア
- 音声録音、字幕検索、会話履歴の提供
- 話者の自動登録、課金、管理画面
- 非公開スレッド（private thread）や DM への字幕配信
- 完全な同時通訳、または再生開始300 ms以内の保証

## 3. 現在の検証状態

検証状態はこの章を正本とします。README には、導入判断に必要な要約だけを載せます。

### 3.1 自動確認済み

現行環境では、次が成功しています。

- ESLint
- TypeScript 型検査
- 公開境界・統合テスト148件
- 本番用ビルド
- `better-sqlite3`と`@discordjs/opus`の実行時スモークテスト
- 本番向けの依存関係の監査
- Compose 設定検証
- Docker ビルド
- 図版の HTML・SVG 同期

CI でも、この一覧にある検査を実行します。

### 3.2 実機確認の履歴

以前の UI を使った版では、実際の Discord・Soniox 環境で日韓1人通話を行い、字幕と読み上げを確認しました。8発話について、処理区間ごとの遅延も計測しています。発話中に確定翻訳を TTS へ送る実験も行いましたが、通常操作と安定性を優先し、現行版には採用していません。

この履歴は、現行版の E2E が成功した証拠にはなりません。当時の版では、次の現行機能を確認していないためです。

- セッションカード
- 専用スレッド
- 仮字幕
- 2種類の再生モード
- 話者別の voice

### 3.3 未検証

- 現行版を実際の Discord・Soniox 環境で通す E2E
- 2人・3人での同時通話
- 日英と韓英
- 3言語ペアの30分継続運転
- 実請求額とローカル台帳の照合精度
- 複数 Guild の同時運転
- Discord DAVE が有効な環境での受信ストリーム復旧
- 実デプロイ環境の GitHub Actions

## 4. 利用者から見える振る舞い

### 4.1 コマンド

Bot は Guild 内だけで使える`/translate`を登録します。

| コマンド | 引数 | 動作 |
|---|---|---|
| `/translate start` | `pair`必須、`mode`任意 | 実行者が参加中の音声チャンネルで翻訳を開始する |
| `/translate stop` | なし | 実行中のセッションを停止する |

`pair`は3言語ペアから選びます。`mode`を省略すると`conversation`になります。コマンドの`default_member_permissions`は`0`であり、Discord 側では管理者または明示的に許可された利用者だけが実行できます。

### 4.2 開始条件

`/translate start`は、次の条件を順に確認します。

1. コマンドが Guild 内で実行されたこと
2. Guild が`ALLOWED_GUILD_IDS`に含まれること
3. 実行者が`ALLOWED_USER_IDS`に含まれること
4. 実行者が対象の音声チャンネルへ参加していること
5. 音声チャンネルの全人間参加者が許可されていること
6. 人間参加者が`MAX_SPEAKERS_PER_SESSION`以下であること
7. Bot が必要な音声・テキスト・公開スレッド権限を持つこと
8. 同じ Guild に開始中または実行中のセッションがないこと
9. User・Guild・Global の利用上限内であり、利用量照合が古くないこと
10. Soniox の Project と Organization に、設定上限人数分の STT ストリームと1本の TTS ストリームの空きがあること

開始時の Soniox 容量確認は、現在の参加者数ではなく`MAX_SPEAKERS_PER_SESSION`本の STT ストリームを予約できる前提で判定します。開始後に参加者が増えた場合も、追加利用者の上限を確認します。

### 4.3 セッションカードと字幕

開始に成功すると、Bot はコマンドを実行した親テキストチャンネルへセッションカードを投稿します。そのカードから公開スレッドを作り、仮字幕と確定字幕をスレッドへ投稿します。

カードには、言語ペア、参加者、経過時間、音声の待ち時間、再生モード、実行状態を表示します。カードから次を操作できます。

- セッションの停止
- 音声再生と字幕のみの切り替え
- 会話優先と正確さ優先の切り替え
- 字幕を送れない場合に、音声翻訳を継続するかセッションを停止するかの切り替え

カードを操作できるのは、開始者、対象音声チャンネルに現在参加している利用者、または`Manage Guild`権限を持つ利用者です。コンポーネントに含まれる Session ID が現行セッションと一致しない場合は、終了済みのカードとして拒否します。

公開スレッドは、親チャンネルを閲覧できるメンバーからも見えます。終了後はアーカイブしますが、自動削除はしません。

### 4.4 参加者の変化

セッション中は Voice State を監視します。

- 許可されていない人間が入室した場合は、`SPEAKER_NOT_ALLOWED`で停止します。
- 設定人数を超えた場合は、`TOO_MANY_SPEAKERS`で停止します。
- 人間参加者が0人になった場合は、`VOICE_EMPTY`で停止します。
- Bot が対象音声チャンネルから外れた場合は、`BOT_VOICE_REMOVED`で停止します。
- 許可された利用者が増えた場合は、その利用者の月間上限を確認してからストリームを追加します。

## 5. システム構成

[システム構成図（SVG）](./diagrams/system-architecture.svg)<br>
[ブラウザー表示用 HTML](./diagrams/system-architecture.html)

Bot は外部から HTTP 接続を受けません。Discord Gateway・Voice と Soniox の固定エンドポイントへ、外向きに接続します。

### 5.1 起動時

`startApplication`は、次の順に初期化します。

1. 環境変数を検証する
2. 翻訳用語を読み込む
3. SQLite を開き、スキーマを作成または確認する
4. 前回の異常終了で残ったセッションとプロバイダー要求を失敗扱いにする
5. 保持期限を過ぎた利用量を削除する
6. Soniox の STT・TTS モデル、3言語、3言語ペア、voice、無音短縮、速度を確認する
7. Soniox の同時実行枠 API に到達できることを確認する
8. Soniox `usage logs`とローカル台帳を照合する
9. Discord Gateway へ接続する
10. 定期照合タイマーを開始する

1〜8のいずれかに失敗した場合、Discord へ接続しません。設定不備、課金制御、外部仕様のずれを、利用開始後まで持ち越さないためです。

### 5.2 主要コンポーネント

| コンポーネント | 責務 | 主な実装 |
|---|---|---|
| 設定 | 環境変数、リージョン、上限、ファイルパスを Fail Fast で検証する | `src/config.ts` |
| Command Service | Guild・利用者・参加者・権限を認可する | `src/commands/translation-command-service.ts` |
| Session Manager | Guild ごとの単一セッションと状態を管理する | `src/session/session-manager.ts` |
| Discord Driver | Voice 受信、STT ストリーム、字幕、再生、復旧を統合する | `src/discord/translation-driver.ts` |
| Utterance Processor | 発話確定後の字幕、TTS、FIFO、割り込みを管理する | `src/translation/utterance-processor.ts` |
| Soniox Control | モデル・容量の事前確認、STT 作成、`usage logs`照合を行う | `src/soniox/control.ts` |
| TTS Gateway | 常時接続する WebSocket とストリームのライフサイクルを管理する | `src/soniox/raw-tts-gateway.ts` |
| Usage Ledger | 利用量、見積額、照合額、保持期限を SQLite で管理する | `src/usage/usage-ledger.ts` |
| Safe Logger | ID の仮名化と内容を含まない構造化ログを行う | `src/observability/logger.ts` |

## 6. セッションの状態

[状態遷移図（SVG）](./diagrams/session-state.svg)<br>
[ブラウザー表示用 HTML](./diagrams/session-state.html)

`SessionManager`の状態を表す列挙型（enum）は、次の5値です。セッションが存在しない状態は、`Map`に該当エントリがないことで表現し、この enum には含みません。

| 状態 | 意味 |
|---|---|
| `AUTHORIZING` | ローカル利用上限と Soniox 同時実行枠を確認中 |
| `CONNECTING` | Discord チャンネルの再確認、台帳作成、Voice 接続、カード・スレッド作成を実行中 |
| `ACTIVE` | 発話を受信し、翻訳できる |
| `FAILED` | 開始処理が失敗し、エントリを除去する直前の一時状態 |
| `STOPPING` | 開始中断または実行中セッションの停止処理中 |

通常の遷移は、セッションなし→`AUTHORIZING`→`CONNECTING`→`ACTIVE`→`STOPPING`→セッションなしです。

開始中に例外が発生した場合は、`FAILED`を経てエントリを除去します。一方、`ACTIVE`中に復旧不能な障害が発生した場合は、`FAILED`へ遷移せず、`STOPPING`へ直接進みます。Global 上限または Soniox の402を検出した場合も、現行実装が停止するのは障害を検出した Guild のセッションだけです。

## 7. 1発話の処理

[発話シーケンス図（SVG）](./diagrams/utterance-sequence.svg)<br>
[ブラウザー表示用 HTML](./diagrams/utterance-sequence.html)

### 7.1 音声受信

Discord Voice から発話者別の Opus パケットを受信し、48 kHz・16 bit・stereo PCM へ復号します。続いて mono PCM へ変換し、Soniox STT へ送ります。STT 接続が完了するまでのパケットは、250件または512 KiBのうち、先に達した方を上限としてバッファへ保持します。上限を超えた場合は、音声を黙って欠落させず、セッションを停止します。

破損したと判定した Opus パケットは、その1件だけを破棄し、ストリームを継続します。音声受信ストリームが`close`した場合は、直前の`error`を原因として保持し、200 ms後に再購読します。再購読後に`data`パケットを1件受け取ると、復旧回数を0へ戻します。1件も受け取れないまま4回連続で復旧できなかった場合は、セッションを停止します。それ以外の復号エラー、パケット解析エラー、STT への送信エラーでは、`SONIOX_STREAM_FAILED`としてセッションを停止します。

### 7.2 STT と仮字幕

発話者ごとに、次の設定で Soniox STT を開始します。

- PCM signed 16 bit little-endian
- 48 kHz
- mono
- 選択した2言語の hint
- language identification
- semantic endpoint detection
- two-way translation
- 任意の translation terms

STT の token は、`is_final`、`translation_status`、`language`、`source_language`を確認して組み立てます。未確定 token は TTS へ送りませんが、確定済み token と組み合わせて仮字幕へ表示します。仮字幕の更新は、発話者ごとに最大500 ms間隔へ抑えます。

選択した言語ペア以外を検出した場合は、その発話を翻訳せず、スレッドへ英語の警告を投稿します。

### 7.3 発話境界

次のいずれかで発話を確定します。

| 経路 | 条件 |
|---|---|
| semantic endpoint | Soniox が`endpoint`を返した |
| manual finalize | Discord の発話終了から100 ms待ち、200 ms分の無音 PCM と finalize を送った |
| inactivity | STT の認識内容が3秒進まなかった |
| maximum duration | 最初の認識進行からの経過時間が`UTTERANCE_MAX_SOURCE_SECONDS`に達した |

`endpoint`または`finalized`を1発話の境界として扱い、確定済みの原文・翻訳文が揃っている場合だけ後段へ進めます。空の発話は仮字幕を削除して終了します。

### 7.4 字幕と TTS

発話境界を確定すると、確定字幕の投稿と TTS 生成を並行して開始します。字幕投稿の完了は音声再生の条件にしません。

TTS WebSocket は発話開始時に接続だけを先行させます。API Key を含むストリーム設定、翻訳本文、`text_end`を送るのは発話境界の確定後です。TTS 応答は Zod で検証し、1メッセージの最大サイズを8 MiBに制限します。

TTS には次を指定します。

- `tts-rt-v2`
- 翻訳先言語
- 発話者に割り当てた voice
- 48 kHz PCM
- `SONIOX_TTS_SPEED`
- 無音短縮
- 発話・プロバイダー要求と対応する不透明な ID

### 7.5 再生順とモード

再生順は、発話境界を確定した順の FIFO です。先行発話の再生中は、後続1発話まで TTS を準備できます。待機音声をメモリへ保持する場合は、48 kHz mono PCM の120秒相当を上限とします。

| モード | 待ち時間が2.5秒を超えたとき | 新しい発話が始まったとき |
|---|---|---|
| `conversation` | 待機中の翻訳音声を省略する | 再生中・待機中・生成中の翻訳音声を中断する |
| `accuracy` | FIFO を維持し、カードへ遅延警告を表示する | 中断しない |

音声を字幕のみに切り替えた場合は、再生中・待機中・生成中の TTS を止め、以後の発話は字幕だけを投稿します。

`PLAYBACK_QUEUE_MAX_MS`は既存の配置との互換性を保つため、必須の設定名として残しています。ただし、現行の実行時処理では、停止条件にも2.5秒の判定にも使いません。

### 7.6 字幕失敗

初期設定は`continue_audio`です。

- 仮字幕の新規投稿または確定字幕の新規投稿に失敗した場合、`continue_audio`では警告を記録して音声を継続します。
- `stop_session`では、新規投稿失敗を`CAPTION_SEND_FAILED`としてセッション停止へ伝えます。
- 既存字幕の編集や削除に失敗した場合は、どちらの方針でもセッションを停止しません。

## 8. データ設計

SQLite は WAL mode で開きます。親ディレクトリを新しく作る場合は`0700`とし、DB ファイルは既存か新規かを問わず`0600`へ設定します。既存の親ディレクトリの権限は変更しないため、運用者が事前に確認します。

### 8.1 保存するテーブル

| テーブル | 主な内容 |
|---|---|
| `session_usage` | Session ID、Guild・Voice Channel・Text Channel・開始者の ID、言語ペア、開始・終了時刻、終了理由、見積額・照合額 |
| `provider_request` | Provider Request ID、Session ID、User ID、STT/TTS、状態、利用時間、文字数、見積額・照合額 |
| `monthly_usage` | User・Guild・Global ごとの月、利用時間、文字数、見積額・照合額 |
| `app_meta` | 最終照合時刻と書き込み確認 |

Bot の SQLite には、音声、原文、翻訳文、表示名を保存しません。ただし、前表に記載した Discord ID は運用メタデータとして保存します。

### 8.2 異常終了からの復旧

起動時に、終了していない`provider_request`を`failed`へ変更し、終了していない`session_usage`を`PROCESS_RESTART`で終了します。中断した処理を成功扱いにせず、次の照合対象として残します。

### 8.3 保持期限

- User・Guild の月次集計は、当月と前月を保持します。
- 終了済みセッションと紐づくプロバイダー要求は、前月の開始より古いセッションを削除するときに削除します。
- Global の月次集計は、当月を含む12か月を保持します。

Discord の公開スレッドと字幕メッセージは SQLite の保持処理とは無関係です。セッション終了時にはアーカイブしますが、削除はしません。

## 9. 利用量と費用制御

### 9.1 ローカル見積もり

ローカル見積もりには、次の利用量を使います。

- STT ストリームの利用時間
- TTS が生成した音声の時間
- 課金対象として数えるテキストの文字数

各利用量に設定済みの単価と安全係数を適用し、microUSD の整数に切り上げます。上限判定には、ローカル見積額と Soniox `usage logs`の照合額のうち、大きい方を使います。

上限は User、Guild、Global の3段階です。設定時には次を満たす必要があります。

```text
User <= Guild <= Global < Soniox Project budget
```

上限に達した User の新規参加、Guild の新規セッション、Global 上限後の新規セッションは拒否します。上限判定後に発生した利用量も台帳へ加算し、エラーで隠しません。

### 9.2 Soniox `usage logs`との照合

起動時、セッション終了時、配布設定では60秒ごとに`usage logs`を取得します。ローカルの provider request ID と`client_reference_id`を対応させ、Soniox の`cost_usd`を照合額として記録します。

最終照合から配布設定で180秒を超えた場合、新規セッションと新規参加者を拒否します。照合 API の障害時に、古い見積もりだけで利用を続けないためです。

### 9.3 Project 上限

`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`は、Soniox Console に設定した Project 上限をローカル設定に転記する値です。Bot はこの環境変数から Soniox Console の設定を変更しません。

Soniox のエラーは、次のように正規化します。

| Soniox の応答 | Bot の分類 |
|---|---|
| 401・403 | 認証失敗 |
| 402 | 予算到達 |
| 429 | 同時実行上限 |
| その他のストリームエラー | プロバイダー障害 |

### 9.4 現行実装の制約

Global 上限または Soniox 402を1つの Guild で検出しても、現行実装は、その Guild のセッションだけを停止します。別 Guild ですでに動いているセッションを直ちに一括停止する処理は未実装です。新規開始は Global 上限によって拒否され、別 Guild も次に同種のプロバイダーエラーを受けた時点で個別に停止します。

このため、`GLOBAL_MONTHLY_COST_LIMIT_MICROUSD`をプロセス全体の即時停止機能として扱ってはいけません。公開範囲を広げる前に、一括停止の要否を判断する必要があります。

## 10. 設定

`.env.example`の値は配布時の初期値です。`SONIOX_TTS_SPEED`を除き、コード内のフォールバック値ではありません。

### 10.1 秘密値と許可リスト

| 設定 | 配布初期値 | 制約 |
|---|---:|---|
| `DISCORD_TOKEN` | 空 | 必須、Git 管理外 |
| `DISCORD_APPLICATION_ID` | 空 | 17〜20桁 |
| `ALLOWED_GUILD_IDS` | 空 | 17〜20桁の ID を1件以上 |
| `ALLOWED_USER_IDS` | 空 | 17〜20桁の ID を1件以上。全発話者を含める |
| `SONIOX_API_KEY` | 空 | 必須、Bot 専用 Project |
| `LOG_ID_HMAC_KEY` | 空 | 32文字以上、他用途と共有しない |

### 10.2 セッション

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `SESSION_MAX_MINUTES` | `30` | セッション最大時間 |
| `MAX_SPEAKERS_PER_SESSION` | `2` | 最大参加者。許容範囲は1〜3 |
| `SESSION_IDLE_TIMEOUT_SECONDS` | `120` | 人間の音声パケットがない場合の停止時間 |
| `PLAYBACK_QUEUE_MAX_MS` | `10000` | 互換性のために残る必須値。現行の実行時判定には未使用 |
| `UTTERANCE_MAX_SOURCE_SECONDS` | `30` | 1発話の認識進行から確定までの上限 |
| `TTS_MAX_INPUT_CHARACTERS` | `300` | 1発話の翻訳本文上限 |
| `VOICE_RECONNECT_TIMEOUT_MS` | `5000` | Discord Voice 再接続待ち |
| `SONIOX_TERMINATION_TIMEOUT_MS` | `5000` | TTS ストリーム終了待ち |

### 10.3 利用上限と照合

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `USER_MONTHLY_COST_LIMIT_MICROUSD` | `1000000` | User 月間上限 |
| `GUILD_MONTHLY_COST_LIMIT_MICROUSD` | `3000000` | Guild 月間上限 |
| `GLOBAL_MONTHLY_COST_LIMIT_MICROUSD` | `4000000` | Bot 全体の月間上限 |
| `SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD` | `5000000` | Console の Project 上限を写す値 |
| `STT_COST_MICROUSD_PER_HOUR` | `120000` | STT 時間単価 |
| `TTS_COST_MICROUSD_PER_HOUR` | `700000` | TTS 音声時間単価 |
| `TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND` | `16000000` | テキストの保守的な文字単価上限 |
| `COST_ESTIMATE_SAFETY_PERCENT` | `125` | 見積額の安全係数 |
| `PRICING_CONFIRMED_AT` | `2026-08-15` | 単価を一次情報で確認した日 |
| `PRICING_MAX_AGE_DAYS` | `30` | 単価確認日の有効期間 |
| `USAGE_RECONCILE_INTERVAL_SECONDS` | `60` | 定期照合間隔 |
| `USAGE_RECONCILE_MAX_STALENESS_SECONDS` | `180` | 新規開始を拒否する照合経過時間 |
| `SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS` | `30` | Soniox control API の timeout |

料金確認日が未来、日付形式が不正、または有効期間を過ぎている場合は起動を拒否します。料金が変わった場合は単価だけでなく`PRICING_CONFIRMED_AT`も更新します。

### 10.4 Soniox と保存先

| 設定 | 配布初期値 | 意味 |
|---|---:|---|
| `SONIOX_REGION` | `us` | `us`、`eu`、`jp`の固定エンドポイントを選ぶ |
| `SONIOX_STT_MODEL` | `stt-rt-v5` | STT モデル |
| `SONIOX_TTS_MODEL` | `tts-rt-v2` | TTS モデル |
| `SONIOX_TTS_SPEED` | `1.15` | 0.7〜1.3。省略時も1.15 |
| `SONIOX_VOICE_JA` | `Kenji` | 話者枠1の多言語 voice |
| `SONIOX_VOICE_KO` | `Mina` | 話者枠2の多言語 voice |
| `SONIOX_VOICE_EN` | `Emma` | 話者枠3の多言語 voice |
| `TRANSLATION_TERMS_PATH` | 空 | 任意。指定時は絶対パス |
| `SQLITE_PATH` | `/data/usage.sqlite` | 必須の絶対パス |

3つの`voice`設定値は重複できません。用語ファイルは3言語ペアすべてを持つ厳格な JSON とし、同じ言語ペア内で`source`を重複できません。各言語ペアの JSON 表現が10,000文字を超える場合も拒否します。

## 11. セキュリティとプライバシー

### 11.1 信頼境界

| 境界 | 制御 |
|---|---|
| Discord の利用者→Bot | Guild・User 許可リスト、Guild 限定コマンド、Discord 権限、Session ID、操作権限 |
| Discord Voice→音声処理 | 対象 VC、Bot 以外の参加者、最大人数、Opus 復号、上限付きの起動時バッファ |
| Soniox→Bot | 固定 HTTPS・WSS エンドポイント、TLS、SDK 型、Zod の通信スキーマ、要求タイムアウト、ペイロード上限 |
| Bot→Discord のテキスト | Markdown のエスケープ、メンション無効化、4,000文字上限、公開スレッド権限 |
| Bot→SQLite | prepared statement、スキーマ制約、WAL、新規作成時`0700`のディレクトリ、`0600`のファイル |
| 運用者→設定 | `.env.local`と実用語ファイルを Git・Docker のビルドコンテキストから除外し、起動時にフェイルファストで検証 |

### 11.2 認証情報

Discord Token、Soniox API Key、HMAC key は環境変数からだけ読み込みます。ログは例外メッセージとスタックを出さず、`ApplicationError`のコードとエラー名だけを記録します。致命的な設定エラーでも、設定名と検証理由だけを出し、値は出しません。

TTS WebSocket では API Key をストリーム設定メッセージへ含めます。接続先は、`SONIOX_REGION`から選ぶ固定 WSS URL です。利用者が任意の URL を指定する設定はありません。

### 11.3 ログ

Discord の Guild・User ID は HMAC-SHA-256で仮名化し、先頭20桁の16進表現を記録します。発話本文、字幕本文、表示名、Token、API Key は記録しません。Session ID と Provider Request ID は、利用量照合と処理追跡に使う不透明な ID として記録します。

### 11.4 Bot の利用範囲を広げる前に残るプライバシー上の制約

- 公開スレッドは親チャンネルの閲覧者から見えます。
- 字幕は Discord 側へ残り、自動削除しません。
- SQLite は生の Discord ID と Channel ID を一定期間保存します。
- 音声と翻訳内容を Discord と Soniox へ送ることについて、参加者の同意を強制する仕組みはありません。
- 用語ファイルへ秘密情報を入れると、STT のコンテキストとして Soniox へ送信します。

このため、限定公開の対象を現在の許可リストより広げる前に、運用規約で次を定める必要があります。

- 参加者から同意を得る方法
- 字幕を閲覧できる範囲
- 字幕と保存データの削除方針
- 保存期間
- 問い合わせ窓口

## 12. 障害処理

主な停止条件は次のとおりです。

| 分類 | 例 | 動作 |
|---|---|---|
| 認可 | 未許可 Guild・User | 開始を拒否する |
| 参加者 | 未許可参加者、人数超過、無人 | セッションを停止する |
| Discord 権限 | Voice・Text・Thread 権限不足 | 開始を拒否し、不足権限名を返す |
| 利用量 | User・Guild・Global 上限、照合の期限切れ | 開始または参加を拒否し、検出 Guild を停止する |
| Soniox | 認証、予算、同時実行枠、ストリーム障害 | 公開用コードへ正規化し、検出 Guild を停止する |
| Discord Voice | Bot の退出、再接続失敗、受信ストリーム復旧失敗 | セッションを停止する |
| 発話 | 原音声の長さ、TTS 文字数、待機音声の上限 | 対象エラーでセッションを停止する |
| 字幕 | 新規投稿失敗 | 設定に従い、音声継続または停止する |
| プロセス | SIGINT・SIGTERM | 新規コマンドを止め、全セッション、照合、Discord、TTS、SQLite の順に終了する |

公開メッセージは、具体的な内部例外や認証情報を含めません。カードの終了理由には、運用者が追跡できる固定コードを併記します。

## 13. 可観測性

ログは1行につき1件の JSON です。主なイベントは次のとおりです。

| イベント | 用途 |
|---|---|
| `application_ready` | Discord 接続と起動準備の完了 |
| `startup_recovery_complete` | 異常終了から復旧した件数 |
| `usage_retention_complete` | 保持期限で削除した件数 |
| `soniox_preflight_complete` | Soniox の起動前確認完了 |
| `translation_flow` | 本文を含まない処理段階 |
| `translation_latency` | 1発話の区間時間 |
| `translation_runtime_warning` | 局所復旧、字幕編集失敗などの警告 |
| `translation_runtime_failed` | セッション停止へ至った障害 |
| `usage_reconciliation_failed` | 定期照合の失敗 |
| `application_shutdown_complete` | graceful shutdown の完了 |

`translation_latency`の`trace_id`は1発話を表します。`playback_started.total_ms`は、最後の音声パケットを受信してから再生を始めるまでの時間です。字幕投稿と TTS は並行するため、ステージの観測順は一定ではありません。

## 14. 配置と運用

### 14.1 Docker

Dockerfile は、ビルド用と実行用を分けた multi-stage 構成です。実行用ステージは Node 24.17.0の`node`利用者で動かし、`/data`だけを永続ボリュームとします。Bot は待受ポートを持ちません。

Compose は次を行います。

- `.env.local`を環境変数として渡す
- SQLite を名前付きボリュームへ保存する
- 翻訳用語ファイルを読み取り専用でマウントする
- `init: true`で PID 1のシグナル処理を補助する
- `restart: unless-stopped`で異常終了後に再起動する
- 30秒の停止猶予を設ける

ブリッジネットワークを作れないホスト向けに`compose.host.yaml`があります。ホストネットワークは分離を弱めるため、標準構成にはしません。

### 14.2 Command 登録

`pnpm register-commands`は、`ALLOWED_GUILD_IDS`の各 Guild へ`/translate`を PUT します。許可リストから削除した Guild の既存コマンドを削除する処理はありません。実行時には、その Guild からの操作を引き続き拒否しますが、古いコマンドの表示は残る可能性があります。

### 14.3 終了

SIGINT または SIGTERM を受けると、新規コマンドを拒否し、全 Guild のセッションを停止します。その後、必須の`usage logs`照合が終わるまで待ち、Discord のリスナーとクライアント、TTS WebSocket、SQLite を閉じます。

## 15. 採用した実装手段

### 15.1 再利用したもの

- Discord Gateway、Application Command、Components V2、Voice、権限判定は、採用済みの`discord.js`と`@discordjs/voice`を使います。
- Soniox STT、モデル、`usage logs`、`concurrency limits`には、公式`@soniox/node`を使います。
- 入力と外部応答の検証には、採用済みの Zodを使います。
- 永続化には、採用済みの`better-sqlite3`と SQLite の制約・トランザクションを使います。
- HMAC、UUID、AbortSignal、ストリームには Node.js 標準機能を使います。

### 15.2 限定的な独自実装

Soniox Node SDK の公開 TTS インターフェースだけでは、現行要件に必要なストリーム単位の制御を一貫して扱えません。対象は、設定、`client_reference_id`、速度、無音短縮、明示的な終了、キャンセルです。そのため、採用済みの`ws`で TTS の通信境界を実装しています。URL は設定から任意に受け取らず、リージョンごとの固定エンドポイントを渡します。受信イベントは Zod で検証します。

### 15.3 採用しなかったもの

発話中の確定トークンを逐次 TTS へ送る方式は、短い実測遅延を狙える一方で、通常の話し方ではストリーム終端とキャンセルが不安定になりました。現行版は、`semantic endpoint`または`manual finalize`で発話境界を確定してから本文を送ります。

また、再生待ちが増えたときにセッション全体を停止する方式は採用していません。会話優先では遅い音声を省略し、正確さ優先では FIFO と警告を維持します。

## 16. 限定公開の試用版に対する受入条件

現行版を受け入れるには、少なくとも次を実サービスで確認します。

1. `/translate start`が未許可の Guild・User、未許可参加者、人数超過、権限不足を拒否する
2. 3言語ペアの両方向で、事前に決めた発話例の原文・翻訳字幕と読み上げを確認する
3. 1〜3人で、発話者ごとの voice が途中で入れ替わらず、別の利用者のストリームと混ざらない
4. 仮字幕が更新され、同じメッセージの確定字幕へ置き換わる
5. 会話優先が2.5秒超過と新しい発話で音声を省略・中断する
6. 正確さ優先が FIFO を保ち、遅延警告を表示する
7. 字幕のみへの切り替えが、再生中・待機中・生成中の音声を止め、字幕を継続する
8. 破損した Opus パケットの局所破棄と受信ストリームの再購読で、復旧可能な障害を継続する
9. User・Guild・Global 上限と Soniox Project 上限で、新規利用を定義どおり拒否する
10. graceful shutdown 後に未完了のセッション・プロバイダー要求が残らず、再起動時の復旧結果が正しい
11. 30分運転について、メモリ使用量、待ち時間、字幕、利用量、実請求額を事前の合格基準と照合する

### 16.1 判定方法と証跡

現行リポジトリは、次の項目について合格となる数値を定めていません。

- 翻訳品質
- 遅延
- メモリ増加量
- ローカル台帳と実請求額の差

運営者は試験前に閾値を決め、試験後の結果に合わせて基準を変更しないでください。閾値が未決定の項目は、受入済みと判定できません。

| 対象 | 残す証跡 |
|---|---|
| 試験条件 | 日時、コミット SHA、Discord・Soniox のリージョンとモデル、秘密値を除いた設定 |
| 機能確認 | 3言語ペア・2モード・1〜3人のシナリオ別結果と、失敗時の再現手順 |
| 遅延 | `translation_latency`ログから集計した区間値と、事前に決めた合格閾値 |
| 利用量・費用 | SQLite の集計、Soniox `usage logs`、実請求額の比較結果 |
| 継続運転 | 30分間のメモリ使用量、再接続、字幕失敗、待ち時間の観測結果 |

証跡へ Token、API Key、発話本文、生の Discord ID を含めません。字幕や録音を証跡に残す場合は、参加者の同意と保管・削除方法を先に決めます。

## 17. 公開前に残る判断

### 17.1 Bot の利用範囲を広げる前

1. 複数 Guild が同時に開始・課金すると Global 上限を超過できる競合を解消する
2. 第16章の E2E・複数人・30分継続・利用額照合を完了する
3. 第11.4節にある5項目について、運用規約を定める
4. `ManageThreads`を外した最小権限で、必要なスレッド操作が成功するか実機確認する

### 17.2 リポジトリを一般公開する前

1. `discord_realtime_translation_chat.zip`と`docs/reference/design-structure-sample.md`を公開してよいか、所有者が内容と権利を全文確認する
2. LICENSE、問い合わせ先、`SECURITY.md`、脆弱性報告窓口を用意する
3. 公開対象の最終コミットと Git 履歴について、秘密情報・依存関係・コンテナイメージを再検査する
4. [公開前セキュリティ監査報告](../security_best_practices_report.md)の未解決事項を再判定する

### 17.3 実装判断が必要な項目

1. 予算を原子的に予約するか、プロセス全体を同時1セッションへ制限するか
2. Global 上限または Soniox 402で、全 Guild の実行中セッションを即時停止するか
3. 許可リストから外した Guild のコマンドを安全に削除する運用または CLI を用意するか
4. 字幕を非公開スレッドへ変更するか、終了時に削除するか
5. SQLite に保存する Discord ID の保持期間を短縮または設定可能にするか

## 18. 一次情報

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
