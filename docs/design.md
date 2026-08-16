# Design

## 背景

日本語、韓国語、英語の話者がDiscordの音声チャンネルで会話する場合、聞き手が理解できる言語へ発話を変換するには、別の通訳者または外部の翻訳手段が必要になる。
このプロダクトは、Discordの音声を取得し、翻訳した音声を同じ音声チャンネルへ返すBotとして、その手間を減らす。

会話ログでは、次の制約が挙がっている。

- 翻訳アルゴリズムを独自に実装せず、既存の音声認識、翻訳、読み上げAPIを利用したい
- 字幕だけではなく、翻訳音声を聞ける体験をMVPに含めたい
- 運営者のAPIキーを使うため、第三者による無断利用と従量課金の増加を防ぐ必要がある
- 1つのDiscord音声チャンネルでBotが再生した音声は、特定の利用者だけではなく全参加者に聞こえる
- 3言語を同時に扱うと原音と複数の翻訳音声が混在するため、MVPでは1セッションにつき2言語へ絞る必要がある

MVPは、Sonioxのリアルタイム音声認識と双方向翻訳、ストリーミング読み上げを組み合わせる。
Discord側では参加者別の音声受信、OpusとPCMの変換、翻訳結果の確定判定、読み上げ順の制御を行う。

なお、`@discordjs/voice` は音声の送受信に対応しているが、Discordが音声受信を正式に文書化していないため、安定サポートは保証されていない。
この点は実装上の既知リスクであり、MVP着手前のPoCで継続受信を確認する。

## 目的

Discordの音声チャンネルで、2つの言語を話す最大3人が、元の話し方を変えずに双方向の会話を続けられる状態をつくる。

### ゴール

- 日本語と韓国語、日本語と英語、韓国語と英語のいずれかを選び、双方向に翻訳できる
- 発話を翻訳音声へ変換し、同じDiscord音声チャンネルで再生できる
- 認識した原文と翻訳文を、確認用字幕としてDiscordのテキストチャンネルへ投稿できる
- 暫定翻訳を読み上げず、後から取り消せない音声には確定済みの翻訳だけを使う
- Guild許可リスト、同時実行数、セッション時間、月間利用量、全体費用でAPI利用を制限できる
- 音声、原文、翻訳文をBotサーバーへ永続化せずに運用できる
- 発話から翻訳音声の再生までの遅延と、APIの実料金を計測できる

### MVP完了条件

- 3つの対応言語ペアについて、両方向の音声翻訳が実機のDiscord音声チャンネルで動作する
- `MAX_SPEAKERS_PER_SESSION=3`の30分通話で、3人分のDiscord音声受信、Soniox接続、字幕投稿、読み上げ再生が途中停止しない
- 暫定トークンがTTSへ送られないことを、イベントログと字幕で確認できる
- ミュート操作なしの自然な発話で、最後のDiscord音声packetから翻訳音声の再生開始までのp50、p95と区間内訳を記録できる
- Bot自身の読み上げ音声を再入力せず、翻訳ループが発生しない
- `/translate stop`、最大時間、無音、参加者不在、利用上限の各条件で、音声受信と外部API接続が終了する
- 未許可Guildまたは上限超過の要求では、Sonioxへ接続する前に処理を拒否する
- Sonioxの利用ログとローカル利用量台帳を照合し、セッションごとの実料金を確認できる

当初の300 ms目標は、発話中に確定翻訳をTTSへ流す実験構成でのみ到達可能性を確認した。一方、実DiscordではTTSの翻訳方向と発話境界が確定する前にprovider状態を作ることが不安定化の要因になった。通常操作と安定性を優先し、現行設計はSonioxの`endpoint` event後にだけTTSを開始する。そのため300 msはMVPの必須受入条件から外し、現行版の実Discord計測後に目標値を再設定する。
FIFO待ちは同じ`trace_id`の`playback_slot_ready.total_ms - queue_enqueued.total_ms`から導出し、10秒を超えた場合はセッションを停止する。

### 非ゴール（今回のスコープ外）

- 3言語を同じセッションで同時に翻訳すること
- 4人以上の発話をMVPの動作保証範囲に含めること
- 聞き手ごとに異なる翻訳音声を同じ音声チャンネル内で配信すること
- 元の話者の声色、声の高さ、抑揚を再現すること
- 字幕だけで完結する翻訳モード
- 音声、原文、翻訳文のBotサーバーへの保存と検索
- Web管理画面、Discord OAuth、利用者自身のAPIキーを登録するBYOK
- Guild管理者がDiscord上で用語集を編集する機能
- Soniox障害時に別の翻訳事業者へ自動で切り替える機能
- 複数Botプロセスによる水平分散
- 無制限の一般公開

## 設計判断

ZIP内の `discord_realtime_translation_chat.md` と `.txt` は同じ会話内容である。
設計では、会話後半の訂正と最終案を優先し、初期案と矛盾する説明を採用しない。

| 論点 | 採用する判断 | 会話ログ内の根拠 |
| --- | --- | --- |
| 出力 | 字幕だけではなく翻訳音声をMVPに含める | `discord_realtime_translation_chat.md:604-692` |
| API | SonioxをMVPの第一候補とする | `discord_realtime_translation_chat.md:930-959`, `1030-1102` |
| 言語 | `ja-ko`、`ja-en`、`ko-en`から1ペアを選ぶ | `discord_realtime_translation_chat.md:1030-1038` |
| 処理 | 音声認識と翻訳、確定待ち、TTS、Discord再生に分ける | `discord_realtime_translation_chat.md:1040-1052` |
| 字幕 | 原文、翻訳文、読み上げ区切りの確認用に残す | `discord_realtime_translation_chat.md:1063-1071` |
| 利用制御 | Guild許可リスト、同時1セッション、最大30分、無音終了、月間上限、全体費用上限を設ける | `discord_realtime_translation_chat.md:1019-1028` |
| Discord上の制約 | 同じ音声チャンネルでは、Botの翻訳音声が全参加者に聞こえることを受け入れる | `discord_realtime_translation_chat.md:87-155` |

会話ログのAPI仕様と価格は一次情報ではないため、2026年8月15日時点のSoniox、Discord、discord.jsの公式資料で再確認した。
現在のSonioxは、リアルタイム音声認識と翻訳を同じWebSocket APIで返し、確定状態を含むトークンをストリーミングできる。
TTSもテキストチャンクの受信中から音声を返せる。

## 技術構成

| 用途 | 技術 | 選定理由 |
| --- | --- | --- |
| 実行環境 | Node.js 24.17.0以上、TypeScript | 現行の`discord.js` stableドキュメントが示すNode.js要件に合わせる |
| Discord Bot | `discord.js` | Slash Command、Guild、Channel、Userの操作を同じSDKで扱う |
| Discord音声 | `@discordjs/voice` | ユーザー別のOpus受信とBot音声送信を扱う |
| Opus処理 | `@discordjs/opus` | Discordの48 kHz stereo OpusをPCMへ復号し、送信時は`@discordjs/voice`のRaw入力経路でOpusへ符号化する |
| 音声認識と翻訳 | Soniox Real-time STT WebSocket、`stt-rt-v5` | 原文と双方向翻訳を同じストリームで取得できる |
| 読み上げ | Soniox Real-time TTS WebSocket、`tts-rt-v2` | 翻訳テキストを受けながらPCMを返せる |
| Soniox SDK | `@soniox/node` | STT、モデル確認、利用ログ、並行数APIの公式実装と型を再利用する |
| TTS transport | `ws` | 公式SDKが保持しない費用照合IDとstream error種別をraw protocol境界で受ける |
| 利用量保存 | SQLite | 単一プロセスのprivate betaで、外部DBを増やさず永続化できる |
| 配布 | Dockerイメージ | Opusのnative addonとNode.jsの実行条件を固定する |
| CI | GitHub Actions | 型検査、テスト、イメージビルドを同じ環境で実行する |

モデル名は設定可能にするが、任意の文字列へ暗黙にフォールバックしない。
起動時にSonioxのモデル一覧と照合し、設定したモデルが利用できない場合はBotをReadyにしない。
Discord音声受信はstable supportが保証されず、後続版では受信packetの公開形も変更されているため、MVPは`@discordjs/voice`を`0.19.2`へexact pinする。
Discord音声の実機PoCを再実行するまで、この依存だけを自動更新しない。

## システム構成

![Discordリアルタイム翻訳Botのシステム構成](./diagrams/system-architecture.svg)

図の自己完結HTML版: [system-architecture.html](./diagrams/system-architecture.html)

Botバックエンドは、次の4つの責務に分ける。

| 構成要素 | 責務 |
| --- | --- |
| Command and Policy | Slash Commandの検証、Guild許可、Discord権限、月間上限、同時実行数を確認する |
| Session Manager | Guildごとに1つのセッション状態、参加者、期限、終了理由を管理する |
| Audio Translation Pipeline | ユーザー別音声の受信、PCM変換、Soniox接続、確定トークンの振り分け、TTS、再生キュー、字幕を扱う |
| Usage Ledger | セッション、ユーザー、Guild、全体の利用量と料金をSQLiteへ保存する |

Sonioxとの通信は、Botバックエンドからのみ行う。
Discord利用者へAPIキーまたは一時APIキーを渡さない。

### ネットワーク境界

- Discord GatewayとInteractionsにはTLS接続を使用する
- Discord VoiceはUDPの送受信を必要とする
- Soniox STTとTTSにはTLS上のWebSocketで接続する
- SQLiteはBotプロセスからだけ読み書きできる永続ボリュームへ置き、ディレクトリを`0700`、DBファイルを`0600`にする
- Botは外部からHTTPリクエストを受け付けない

`SONIOX_REGION`は任意URLではなく、次の固定マッピングへ解決する。

| 設定値 | REST API | STT WebSocket | TTS WebSocket |
| --- | --- | --- | --- |
| `us` | `api.soniox.com` | `stt-rt.soniox.com` | `tts-rt.soniox.com` |
| `eu` | `api.eu.soniox.com` | `stt-rt.eu.soniox.com` | `tts-rt.eu.soniox.com` |
| `jp` | `api.jp.soniox.com` | `stt-rt.jp.soniox.com` | `tts-rt.jp.soniox.com` |

API Keyを作成したProject regionと異なるhostへは接続しない。

デプロイ先のファイアウォールは、Discord VoiceのUDP送受信と、DiscordおよびSonioxへの外向き通信を許可する。
任意の外部接続先をコマンドや設定画面から指定する機能は設けない。

## コマンド設計

### 基本形

```text
/translate start pair:<ja-ko|ja-en|ko-en>
/translate stop
```

コマンドはGuildコンテキストだけに登録する。
private betaでは許可済みGuildへGuild Commandとして登録し、未許可Guildにはコマンド自体を配布しない。
runtimeでもGuild IDを再検証し、登録状態だけを認可根拠にしない。

### 公開範囲と認可境界

MVPで運営者のDiscord Bot TokenとSoniox API Keyを使うBotは、一般公開しない。
ソースコードを公開する場合も、運営者がホストするBotと認証情報は公開対象から分離する。

Discord Developer Portalでは、次の設定を適用する。

| 設定 | MVPの値 | 目的 |
| --- | --- | --- |
| `Public Bot` | OFF | Application OwnerまたはDeveloper Team以外によるサーバー追加を防ぐ |
| Installation Contexts | `Guild Install`のみ | User Installを許可せず、Botを許可済みGuildへだけ導入する |
| Install Link | `None` | Add App導線と配布用インストールURLを公開しない |
| Slash Commandの登録先 | 許可済みGuildへのGuild Command | 未許可Guildへコマンドを配布しない |
| `default_member_permissions` | `"0"` | Discord上の初期状態では管理者以外にコマンドを公開しない |

MVPのApplicationはunverifiedのまま運用する。
verified Applicationでは`Public Bot`をOFFへ戻せないため、一般公開またはverificationを行う前に認証・課金設計を見直す。

Discord側の設定とコマンド権限は、誤配布を防ぐ第1層として扱う。
Guild管理者による権限変更や設定ミスがあってもSonioxへ接続しないよう、Botは`/translate start`ごとに`ALLOWED_GUILD_IDS`と`ALLOWED_USER_IDS`をruntimeで検証する。
`ALLOWED_USER_IDS`はセッションの開始と音声入力を許可する利用者のリストであり、運営者本人と一緒に翻訳する相手のDiscord User IDだけを設定する。
開始操作だけを許可して話者を無制限に受け入れる構成にはしない。

一般のDiscord利用者へBotを提供する場合は、運営者のAPI Keyを共有する方式を継続しない。
BYOK、利用者アカウント、認証情報の暗号化保存、課金またはクォータ管理を別設計した後に公開範囲を変更する。

### 想定コマンド

| コマンド | 用途 |
| --- | --- |
| `/translate start pair:ja-ko` | 実行者が参加している音声チャンネルで、日本語と韓国語の翻訳を開始する |
| `/translate start pair:ja-en` | 実行者が参加している音声チャンネルで、日本語と英語の翻訳を開始する |
| `/translate start pair:ko-en` | 実行者が参加している音声チャンネルで、韓国語と英語の翻訳を開始する |
| `/translate stop` | 実行中の翻訳を直ちに停止し、外部接続と再生待ち音声を破棄する |

`pair`はDiscordの選択肢として定義し、任意文字列を受け付けない。
ペアの順序は表記だけに使い、翻訳方向を固定しない。
Sonioxには`two_way`を指定し、実際の入力言語に応じて反対側へ翻訳する。

### 開始条件

`/translate start`は、次の条件を上から順に確認する。
1つでも満たさない場合は、その理由と次の操作をephemeral応答で返し、Discord VoiceまたはSonioxへ接続しない。

1. コマンドがGuild内で実行されている
2. Guildが`ALLOWED_GUILD_IDS`に含まれる
3. 実行者が`ALLOWED_USER_IDS`に含まれる
4. 実行者が音声チャンネルへ参加している
5. 対象音声チャンネルの人間の参加者が全員`ALLOWED_USER_IDS`に含まれる
6. 対象音声チャンネルの人間の参加者が`MAX_SPEAKERS_PER_SESSION`以下である
7. Botが音声チャンネルの`ViewChannel`、`Connect`、`Speak`を持つ
8. Botがコマンド実行チャンネルの`ViewChannel`、`SendMessages`を持つ
9. 同じGuildに実行中または開始処理中のセッションがない
10. User、Guild、サービス全体の利用上限に達していない
11. SQLiteが書き込み可能で、Soniox利用ログとの照合が許容時間内に成功している
12. Sonioxの並行数に、`MAX_SPEAKERS_PER_SESSION`本のSTTとTTS 1 streamを開始できる空きがある

開始に成功した場合は、コマンドを実行したテキストチャンネルを字幕チャンネルとして固定する。
途中で別チャンネルへ切り替えない。

```text
翻訳を開始しました
音声チャンネル: General
言語: 日本語 ⇄ 韓国語
字幕: #translation
終了条件: /translate stop、30分、無音上限、参加者不在、利用上限

このセッションの会話音声は、リアルタイム処理のためSonioxへ送信されます。
Botサーバーは音声と字幕本文を保存しません。
```

Discord Interactionは3秒以内の応答が必要なため、最初にephemeralで`deferReply`する。
認可失敗はそのephemeral応答を編集して理由を返す。
開始成功時だけ、字幕チャンネルへ上記の通常メッセージを別途投稿し、ephemeral応答には開始済みであることを返す。
1つのInteraction応答を途中でephemeralから通常投稿へ変更しない。

### 停止権限

次の利用者は`/translate stop`を実行できる。

- セッションを開始した利用者
- 対象音声チャンネルへ参加している人間の利用者
- `ManageGuild`権限を持つ利用者

停止要求を受けた時点で新しい音声入力を受け付けず、再生中の音声、TTSストリーム、再生待ちキューを停止する。
処理中の翻訳を最後まで読み上げるdrainは行わない。
利用者が停止を要求した後も音声処理が続く状態を避けるためである。
未完了の字幕POSTまたは状態編集は明示停止の完了条件にせず、Discordから後で応答が返った場合だけ状態をベストエフォートで更新する。
停止までに受信したTTS音声時間と送信済み文字数は、cancel後も利用量台帳へ記録する。
この台帳更新に失敗した場合は正常停止として扱わず、他の停止処理を継続したうえで停止エラーへ集約する。

実行中のセッションがない場合は、`翻訳セッションは実行されていません`と返す。

## セッション状態

![翻訳セッションの状態遷移](./diagrams/session-state.svg)

図の自己完結HTML版: [session-state.html](./diagrams/session-state.html)

| 状態 | 処理 |
| --- | --- |
| `IDLE` | Guildにアクティブなセッションがない |
| `AUTHORIZING` | Guild、User、権限、上限、永続化状態を確認する |
| `CONNECTING` | Discord Voiceへ接続し、Sonioxモデルと利用可能性を確認する |
| `ACTIVE` | 音声受信、翻訳、TTS、字幕投稿、利用量計測を行う |
| `FAILED` | 開始または実行中に復旧不能な障害を検出し、終了理由を記録する |
| `STOPPING` | 音声購読、Soniox接続、TTS、再生キュー、Discord Voiceを順に閉じる |

状態遷移はGuildごとの排他処理内で行う。
2つの`/translate start`が同時に届いた場合は、最初に`AUTHORIZING`へ遷移した要求だけを続行し、後続を拒否する。

### 自動終了条件

`ACTIVE`では、次のいずれかを検出した時点で`STOPPING`へ移る。

- 開始から`SESSION_MAX_MINUTES`を経過した
- `SESSION_IDLE_TIMEOUT_SECONDS`の間、人間の発話を検出しなかった
- 対象音声チャンネルから人間の参加者がいなくなった
- `ALLOWED_USER_IDS`に含まれない人間が対象音声チャンネルへ参加した
- 対象音声チャンネルの人間が`MAX_SPEAKERS_PER_SESSION`を超えた
- User、Guild、サービス全体のいずれかの上限へ達した
- 再生待ち時間が`PLAYBACK_QUEUE_MAX_MS`を超えた
- SQLiteへの利用量記録を継続できない
- Discord VoiceまたはSonioxで復旧不能なエラーが発生した

自動終了時は、字幕チャンネルへ終了理由と再実行可否を投稿する。

## 音声処理

### 入力経路

1. `VoiceReceiver`の発話開始イベントからDiscord User IDを取得する
2. Botアカウント、対象セッション外の利用者、`ALLOWED_USER_IDS`外の利用者を除外する
3. 許可済みUser IDだけを指定してOpusパケットの受信ストリームを購読する
4. Discordの48 kHz、16-bit、stereo OpusをPCMへ復号し、左右のsampleを平均して48 kHz、16-bit、monoへ変換する
5. UserごとのSoniox STT WebSocketへPCMを送る
6. Sonioxから原文トークンと翻訳トークンを受け取る

MVPはUserごとにSTT WebSocketを1本開く。
同じ音声ストリームへ複数人の音声を混ぜないため、字幕の発話者をDiscord User IDへ確実に対応づけられる。
一度発話したUserの接続はセッション終了まで維持し、無音時は音声を送らずkeepaliveを使用する。
この方式では、発話していない時間もストリーミングセッションとして課金される可能性があるため、`MAX_SPEAKERS_PER_SESSION`の上限を3人とする。

`@discordjs/opus` 0.10.0が`The compressed data passed is corrupted`として拒否したOpus packetは、その1件だけを破棄し、`voice_packet_dropped`を記録して次のpacketを受ける。単発の破損packetでSTT接続とセッション全体を停止しない。Buffer以外の入力、decoderの内部障害、PCM変換失敗は破損packetとして隠さずFail Fastで停止する。

対象音声チャンネルの人間の参加者は、DiscordのVoice State更新に追従する。
途中参加者は`ALLOWED_USER_IDS`に含まれ、同時人数が`MAX_SPEAKERS_PER_SESSION`以下の場合だけ入力対象へ追加し、退出者の音声購読とSTT接続は終了する。
未許可Userまたは設定上限を超える人間が参加した場合は、その音声を購読せずにセッション全体を停止する。
Voice State更新と音声購読の間に競合があっても音声を外部送信しないよう、購読作成の直前にもUser IDを再検証する。
発話境界は自然な無音を受けたSonioxの`endpoint` eventで確定する。Discordのミュートを終端シグナルまたは通常の利用手順にはせず、ミュート時にSTT接続を閉じない。

Sonioxにはraw PCMとして次を指定する。

```json
{
  "model": "stt-rt-v5",
  "audio_format": "pcm_s16le",
  "sample_rate": 48000,
  "num_channels": 1,
  "language_hints": ["ja", "ko"],
  "enable_language_identification": true,
  "enable_endpoint_detection": true,
  "max_endpoint_delay_ms": 1500,
  "endpoint_latency_adjustment_level": 2,
  "endpoint_sensitivity": 0.3,
  "translation": {
    "type": "two_way",
    "language_a": "ja",
    "language_b": "ko"
  },
  "client_reference_id": "<opaque-provider-request-id>"
}
```

`language_hints`と`translation`は選択したペアから生成する。
`language_hints_strict`は有効にしない。
ペア外の言語も識別できる状態を残し、翻訳対象は`two_way`の2言語だけに限定する。
対応ペア外の言語を検出した場合、Sonioxの`translation_status: "none"`をTTSへ送らず、同じUserに対する警告を字幕チャンネルへ1回だけ投稿する。
`max_endpoint_delay_ms: 1500`、`endpoint_latency_adjustment_level: 2`、`endpoint_sensitivity: 0.3`は、Sonioxが多くの低遅延voice applicationの開始値として推奨する構成である。過去のPoCで使った`500 / 3 / 0.5`はより攻めた設定であり、endpointの増加、長い発話の分割、認識精度の低下を招き得るため現行版では使わない。
起動時にモデル一覧を確認し、この3設定とlevel 2に対応しないモデルではReadyにしない。

### 翻訳確定と読み上げ

Sonioxの翻訳トークンには、`translation_status`、`language`、`source_language`、`is_final`が含まれる。
Botは次の条件をすべて満たすトークンだけを、endpoint後にTTSへ送る翻訳文の候補として蓄積する。

- `translation_status`が`translation`である
- `language`が選択した言語ペアの一方である
- `source_language`がその反対側である
- `is_final`が`true`である

Sonioxのwire protocolには`<end>`などの制御トークンがあるが、`@soniox/node` 2.3.0はそれらをtoken配列から除外する。
そのためBotは本文から`<end>`を探さず、SDKの`endpoint` eventを発話境界として扱う。
`is_final: false`の暫定トークンは画面表示にもTTS本文にも使わない。確定原文トークンは言語別に分割せず、1発話の本文として受信順に単一bufferへ保持する。確定原文の言語ラベルは認識中に揺れるため、本文の採否とTTS方向には使わない。

確定翻訳トークンは受信順に連結する。最初の確定翻訳トークンの`source_language`と`language`を発話方向のSSOTとし、同じendpoint内で後続の翻訳方向が変わった場合は`SONIOX_STREAM_FAILED`でFail Fastとする。原文と翻訳の確定組が成立するまで、TTS stream設定、TTS本文、TTS PCMは作らない。

`endpoint` eventを受けるとassemblerをflushし、原文、翻訳文、翻訳方向、発話時間を1発話として確定する。原文または翻訳が空ならTTS要求を作らず、`stt_endpoint_empty`を記録する。確定組がある場合だけFIFOへ入れ、翻訳文全体を1本のTTS streamへ`text_end: true`で送る。独自の形態素解析やLLMによる意味区切り判定は追加しない。

発話時間と翻訳文のUnicode code point数はtoken受信中に加算し、上限超過を`UTTERANCE_TOO_LONG`で即時停止する。TTSはまだ始まっていないため、誤ったvoiceや取消不能なTTS利用量を発生させない。同じ上限をFIFOからTTSへ渡す直前にも再検証する。

Discordのspeaking startでTTS WebSocketの接続だけを開始し、TLSとWebSocketの接続時間を隠す。この時点ではAPI keyを含むstream設定、言語、voice、翻訳本文を送らない。Soniox TTSは接続後およそ10秒以内に最初のstream設定を要求するため、endpoint前に閉じた場合はTTS開始時に再接続する。

最初のstream設定後は20秒間隔で`{"keep_alive": true}`を送り、`terminated: true`を受けた接続を後続発話の別`stream_id`へ再利用する。生成音声がない状態が3分を超えてSoniox側から接続を閉じられた場合も、次の発話で再接続する。active streamの途中で切断した場合は自動再送せず、要求を`failed`としてセッションを停止する。

FIFO processorは同時のTTS生成を1本に制限する。先行発話のTTS生成が完了し、その音声がDiscordで再生中な場合は、すでにendpointで確定した後続1件だけをTTS生成する。これは未確定tokenの先読みではなく、確定済みFIFOの待機処理である。

再生待ちの後続音声は48 kHz mono PCMをメモリへ読み切り、1発話あたり最大2分、11,520,000 byteに制限する。超過時は`TTS_OUTPUT_LIMIT_REACHED`で停止する。再生待ちがない発話は最初のPCMが届き次第再生し、字幕の`再生待ち`投稿の完了は待たない。
再生直前に字幕POSTの失敗が確定済みであれば音声を再生せず、再生開始後に判明した場合はその音声を停止し、いずれもセッションを復旧不能な障害として終了する。
AudioPlayerの`Idle`だけを再生成功と見なさず、`Playing`を観測した後の自然な`Idle`だけを完了とする。再生開始前のstream終了と明示停止は失敗として区別する。
前発話のAudioPlayer完了を字幕POST・状態編集を含む全処理完了とは別のPromiseで管理し、次発話の再生順序には前者だけを使う。

TTSだけは`@soniox/node` 2.3.0ではなく、既存依存の`ws`を使う小さなWebSocket adapterを使用する。
公式SDKの`client.realtime.tts.multiStream()`は接続再利用、自動keepalive、stream単位の取消を備えるため採用可否を先に確認した。
ただし、同SDKのTTS stream設定では利用ログ照合に必要な`client_reference_id`を送れず、`max_audio_duration_reached`の`error_type`も保持されない。
さらに予期しない接続終了をstream errorとして公開しないため、費用のFail Closedと安定したエラーコードという本設計の境界を満たさない。
SDKのprivate socketまたはprivate送信メソッドは使用しない。
STT、モデル一覧、TTSモデル一覧、利用ログ、並行数確認には公式SDKをそのまま使用する。

`@discordjs/voice` 0.19.2の`AudioPlayer`にはqueueまたはprefetch APIがなく、再生中の`play()`は現在のresourceを置換する。
そのため再生順の管理だけはBotのFIFOで行い、外部キューライブラリは追加しない。

```json
{
  "model": "tts-rt-v2",
  "language": "ko",
  "voice": "<configured-multilingual-voice>",
  "audio_format": "pcm_s16le",
  "sample_rate": 48000,
  "reduce_silence": true,
  "stream_id": "<provider-segment-id>",
  "client_reference_id": "<opaque-provider-request-id>"
}
```

起動時にTTSモデルの`supports_silence_reduction`を確認し、対応モデルだけへ`reduce_silence: true`を送る。
Sonioxから返る48 kHz mono PCMの各sampleを左右へ複製し、48 kHz stereoの`StreamType.Raw`としてDiscordのAudioPlayerへ渡す。
Raw入力経路のOpus符号化には`@discordjs/opus`を使用し、既知形式の変換へFFmpegを追加しない。
TTSの音声がすべて届く前でも、最初の再生可能フレームが届いた時点で再生を開始する。

TTS streamは、`text_end: true`の送信後に`audio_end: true`と`terminated: true`を順に受けて、正常完了とする。
`audio_end: true`だけではstreamを完了せず、`terminated: true`を受けるまで`provider_request.status`を`open`のままにする。
利用者または自動終了条件による停止では、active streamへ`cancel: true`を送り、AudioPlayerを停止し、Sonioxの`terminated: true`を待って要求を`failed`へ確定する。
`max_audio_duration_reached`を含むstream errorも直ちに要求を閉じず、後続の`terminated: true`まで追跡する。
最後に何らかのTTS応答を受けてから`SONIOX_TERMINATION_TIMEOUT_MS`内に次の応答が届かなければ、TTS WebSocketを閉じ、要求を`failed`として記録する。

事前上限を通過してもSonioxが`max_audio_duration_reached`を返した場合、すでにDiscordへ再生した音声は取り消せない。
字幕へ`一部再生後に失敗`と表示し、`TTS_OUTPUT_LIMIT_REACHED`でセッションを停止する。

### 1発話の処理順

![1発話を翻訳音声と字幕へ変換する流れ](./diagrams/utterance-sequence.svg)

図の自己完結HTML版: [utterance-sequence.html](./diagrams/utterance-sequence.html)

### 再生キュー

Discord Botが同時に再生できる翻訳音声は1つとする。
複数人が同時に話した場合も、TTS音声を重ねて再生しない。

- Botがendpointを受信した順にFIFOへ入れる
- 再生中の発話を後続発話で中断しない
- endpoint前にTTS stream設定、翻訳本文、PCMを作らない
- 複数話者でもSoniox TTSを同時に2本生成しない
- 先行音声の再生中は、endpointで確定済みの後続1件だけを生成準備する
- 未再生PCMは発話単位で11,520,000 byteを上限とし、再生待ち時間でも打ち切る
- 再生待ち時間をミリ秒で計測する
- `PLAYBACK_QUEUE_MAX_MS`を超えた場合は、新しい翻訳を黙って破棄せず、`PLAYBACK_BACKLOG`としてセッションを停止する

FIFOの基準は、複数のSTT streamからBotへ届いた`endpoint` eventの受付順であり、発話開始時刻ではない。
同一話者の発話は1本のSTT stream内のendpoint順を維持する。
複数話者が重なった場合に、各話者の最後の音声packet時刻を基準として並べ替える待機は追加しない。

同時発話が続くと、翻訳が正しくても聞き手へ届く時刻が遅れる。
この制約は字幕で補完せず、1対1通話の運用上の前提として開始メッセージへ記載する。
遅延は再生待ちがない経路とFIFO待ちを含む発話を分けて集計する。

### 翻訳ループの防止

- `VoiceReceiver`でBotアカウントのUser IDを購読しない
- Discord Userの`bot`属性が`true`の音声をすべて除外する
- 対象音声チャンネルに現在いて、かつ`ALLOWED_USER_IDS`に含まれる人間のUser IDだけを追跡し、Voice State更新時に追加または削除する
- TTS出力を入力バッファへ直接接続しない

Bot音声の再入力を検出した後で捨てるのではなく、音声購読の境界で除外する。

## 字幕設計

字幕は、TTSへ渡した翻訳と、聞こえた翻訳音声を照合するための観測境界である。
暫定トークンを逐次編集するライブ字幕にはせず、Sonioxが発話終端を確定した時点で1発話につき1件を`再生待ち`として投稿する。
この初回POSTはTTS要求と並行して開始し、POST完了前でも最初のTTS PCMを受信した時点でDiscord音声を再生する。
POST失敗が判明した場合は、再生前なら音声を開始せず、再生中なら停止してセッションを終了する。
再生完了、停止、または失敗時に同じメッセージの音声状態だけを編集し、別メッセージを追加しない。

```text
[日本語 → 韓国語] sota
原文: 今日、学校が終わったらVALORANTやらない？
翻訳: 오늘 학교 끝나고 발로란트 할래?
音声: 再生済み
```

字幕には次のルールを適用する。

- Discordの表示名を文字列として表示し、User mentionへ変換しない
- 初回投稿と状態編集の両方で`allowed_mentions: { parse: [] }`を明示し、字幕内の文字列から通知を発生させない
- 原文と翻訳文には確定済みトークンだけを使う
- 初回投稿は`再生待ち`とし、音声再生が完了した場合は`再生済み`、再生前にセッションが停止した場合は`未再生`、音声の一部を再生した後で失敗した場合は`一部再生後に失敗`へ更新する
- APIキー、内部例外、Sonioxの生レスポンス、音声データを含めない
- BotサーバーのDBやログへ字幕本文を保存しない

字幕メッセージはDiscord上に残るため、字幕チャンネルの閲覧権限とDiscord側の保存期間が実質的な保持方針になる。
private betaではGuild管理者が専用チャンネルを用意し、必要な参加者だけに閲覧を許可する。
Botから一括削除する機能はMVPに含めない。

## 用語設定

Sonioxの`context.translation_terms`を使い、ゲーム名、略語、固有名詞の訳を固定できるようにする。
MVPではWeb UIやDiscordコマンドを作らず、起動時に読み込むJSONファイルで管理する。

```json
{
  "ja-ko": [
    { "source": "VALORANT", "target": "발로란트" },
    { "source": "ult", "target": "궁극기" },
    { "source": "gg", "target": "gg" }
  ],
  "ja-en": [],
  "ko-en": []
}
```

双方向で別の表記が必要な語は、反対方向の`source`と`target`も明示する。
同じ`source`に複数の`target`がある、空文字列がある、対応外ペアがある、または各ペアのJSON表現が10,000 Unicode code pointを超える場合は起動エラーにする。
この文字数上限は、Sonioxが示すcontextの目安に対するローカルの安全弁であり、provider側のtoken上限を置き換えるものではない。
不正な用語だけを無視して起動する挙動は採用しない。

Discord Userの表示名を自動で用語設定へ加えない。
表示名を外部APIのcontextへ送る必要がある場合は、運営者が用途を確認して設定ファイルへ明示する。

## データ設計

### メモリ上のセッション

実行中の状態は`Map<guildId, TranslationSession>`で保持する。
セッションには次を含める。

| 項目 | 型 | 用途 |
| --- | --- | --- |
| `session_id` | UUID | ローカルの利用量とSoniox要求を対応づける |
| `guild_id` | Discord Snowflake文字列 | Guildごとの排他と上限判定 |
| `voice_channel_id` | Discord Snowflake文字列 | 音声の入出力先 |
| `text_channel_id` | Discord Snowflake文字列 | 字幕と状態通知の出力先 |
| `started_by_user_id` | Discord Snowflake文字列 | 停止権限と監査 |
| `pair` | `ja-ko`、`ja-en`、`ko-en` | Sonioxの双方向翻訳設定 |
| `state` | セッション状態enum | 状態遷移の排他 |
| `started_at` | UTC日時 | 最大時間と利用量の計測 |
| `last_human_audio_at` | monotonic time | 無音終了の判定 |
| `speaker_streams` | User IDからSTT接続へのMap | User別の音声認識と字幕対応 |
| `playback_queue` | 発話キュー | TTS音声の直列再生 |

入力のOpusとPCMはSonioxへ送信した後に解放する。
確定済みの原文、翻訳文、TTSの未再生フレームは発話処理中のメモリにだけ置く。
再生待ちの確定済みTTS音声は1発話あたり11,520,000 byte以下に制限し、字幕状態の確定と再生完了、停止、またはエラーで解放する。

### SQLite

SQLiteには音声と字幕本文を保存せず、利用量と終了理由だけを保存する。
Discord SnowflakeはJavaScriptの安全な整数範囲を超えるため、すべて`TEXT`として扱う。
金額は浮動小数点ではなく、1米ドルの100万分の1を表す整数`cost_microusd`で保存する。

#### `session_usage`

| 列 | 型 | 制約 |
| --- | --- | --- |
| `session_id` | `TEXT` | 主キー、UUID |
| `guild_id` | `TEXT` | 必須 |
| `voice_channel_id` | `TEXT` | 必須 |
| `text_channel_id` | `TEXT` | 必須 |
| `started_by_user_id` | `TEXT` | 必須 |
| `pair` | `TEXT` | `ja-ko`、`ja-en`、`ko-en`のCHECK制約 |
| `started_at` | `TEXT` | UTCのRFC 3339 |
| `ended_at` | `TEXT` | 実行中のみ`NULL` |
| `end_reason` | `TEXT` | 実行中のみ`NULL`、終了理由enum |
| `stt_stream_ms` | `INTEGER` | 0以上 |
| `tts_audio_ms` | `INTEGER` | 0以上 |
| `text_character_count` | `INTEGER` | 課金見積もりへ使った文字数、0以上 |
| `estimated_cost_microusd` | `INTEGER` | 0以上 |
| `reconciled_cost_microusd` | `INTEGER` | 照合前のみ`NULL` |

#### `provider_request`

| 列 | 型 | 制約 |
| --- | --- | --- |
| `request_ref` | `TEXT` | 主キー。Sonioxへ渡す不透明な`client_reference_id` |
| `session_id` | `TEXT` | `session_usage`への外部キー |
| `user_id` | `TEXT` | 発話者。TTSも元発話者へ帰属させる |
| `kind` | `TEXT` | `stt`または`tts` |
| `status` | `TEXT` | `open`、`completed`、`failed`、`reconciled` |
| `started_at` | `TEXT` | UTCのRFC 3339 |
| `ended_at` | `TEXT` | 未終了のみ`NULL` |
| `audio_ms` | `INTEGER` | ローカル計測値 |
| `text_character_count` | `INTEGER` | 課金見積もりへ使った文字数、0以上 |
| `estimated_cost_microusd` | `INTEGER` | ローカル見積もり |
| `reconciled_cost_microusd` | `INTEGER` | Soniox利用ログとの照合前のみ`NULL` |

`client_reference_id`にはDiscord Guild IDやUser IDを直接入れない。
Botが生成した`request_ref`だけをSonioxへ送り、対応関係はローカルDBに置く。

#### `monthly_usage`

| 列 | 型 | 制約 |
| --- | --- | --- |
| `scope_type` | `TEXT` | `user`、`guild`、`global` |
| `scope_id` | `TEXT` | User ID、Guild ID、または`global` |
| `period` | `TEXT` | `Asia/Tokyo`基準の`YYYY-MM` |
| `stt_stream_ms` | `INTEGER` | 0以上 |
| `tts_audio_ms` | `INTEGER` | 0以上 |
| `text_character_count` | `INTEGER` | 課金見積もりへ使った文字数、0以上 |
| `estimated_cost_microusd` | `INTEGER` | 0以上 |
| `reconciled_cost_microusd` | `INTEGER` | 0以上 |
| `updated_at` | `TEXT` | UTCのRFC 3339 |

主キーは`(scope_type, scope_id, period)`とする。
STT接続時間はUserごとの定期区切りで、TTS費用は確定翻訳バッチごとに、その発話者、Guild、globalの3スコープへ同じトランザクションで加算する。

### 保持期間

- `session_usage`と`provider_request`は当月と前月を保持する
- `monthly_usage`のUserとGuildの行は当月と前月を保持し、それ以前は削除する
- `monthly_usage`のglobal行は費用推移を確認するために12か月保持する
- 保持期限を過ぎたUser ID、Guild ID、Channel ID、個別request_refを削除する
- 音声、原文、翻訳文はBotサーバーへ保存しない

削除処理が失敗した場合は運用アラートを出し、次回実行で再試行する。
保持期間を延ばす場合は、private betaの参加者へ事前に通知する。

## 利用量と費用

### 現行料金の扱い

2026年8月15日時点のSoniox公式価格では、リアルタイムSTTは入力音声約`$0.12/時`、STTとTTSの入力・出力textは`$4.00/100万token`、TTSは生成音声約`$0.70/時`である。
翻訳はリアルタイムSTTと同じAPI呼び出しに含まれるが、翻訳を含む公式概算は約`$0.18/時`であり、出力text token分は0円ではない。
実際の請求はトークン単位であり、contextと出力テキストも課金対象になるため、`$0.82/時`を固定単価として扱わない。

MVPの標準ケースは、2人のSTT接続を60分維持し、合計60分の翻訳音声を生成する通話である。

```text
STT: 2接続 × 1時間 × $0.12 = 約$0.24
TTS: 生成音声1時間 × $0.70 = 約$0.70
合計: 約$0.94 + contextとテキストトークン
```

この概算は会話ログの約`$0.95/通話時間`とほぼ一致するが、費用上限の判定にはSoniox利用ログの実額を使う。
`MAX_SPEAKERS_PER_SESSION=3`ではSTT 3接続分を見込み、同じ60分条件のSTT概算は約`$0.36`となる。

### リアルタイム見積もり

上限へ達してからSoniox利用ログを取得するのでは遅いため、Botは実行中にも費用を見積もる。

- STTはUserごとのWebSocket接続時間を計測する
- TTSは受信したPCMのサンプル数から生成音声時間を計算する
- STTへ送るcontext、STTから受け取る原文と翻訳、TTSへ送る翻訳について、本文を保存せずUnicode code point数だけを加算する
- 音声時間、文字数、安全係数から`estimated_cost_microusd`を算出する
- 発話ごと、またはSTT接続時間の定期区切りごとにSQLiteへ加算する
- 上限判定には`max(estimated_cost, reconciled_cost)`を使う

暫定トークンを含め、Sonioxから受信した本文の各code pointを受信のたびに数える。
同じ暫定文字列が再送された場合も重複して数えるため、実料金を下回りにくい見積もりになる。
STTのcontextはUserごとの接続開始時に、TTS入力はtext chunkの送信時に数える。

```text
audio_cost = ceil(stt_stream_ms × STT_COST_MICROUSD_PER_HOUR / 3,600,000)
           + ceil(tts_audio_ms × TTS_COST_MICROUSD_PER_HOUR / 3,600,000)
text_cost  = ceil(text_character_count × TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND / 1,000,000)
estimated_cost_microusd = ceil((audio_cost + text_cost) × COST_ESTIMATE_SAFETY_PERCENT / 100)
```

単価と安全係数をコードへ固定せず、設定から読み込む。
`TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND`は、STT入力text、STT出力text、TTS入力textの現行単価と、1文字あたりtoken数の安全側見積もりをまとめた上限値とする。
初期値は`16,000,000 microUSD/100万文字`とし、`$4.00/100万token`に対してUnicode code point 1文字を最大4 tokenとして見積もる。
価格改定時に運営者が値を更新しないまま起動しないよう、設定には確認日も含める。

### Soniox利用ログとの照合

Sonioxの`GET /v1/usage-logs`は、モデル、音声時間、トークン、費用、`client_reference_id`を要求単位で返す。
Botは次のタイミングで`provider_request`と照合する。

- `USAGE_RECONCILE_INTERVAL_SECONDS`ごと
- セッション終了後
- Bot起動時

照合要求は1本ずつ実行する。
定期照合は、実行中または待機中に次のintervalが来てもキューへ積み増さず、最新時刻の1件へ集約する。
セッション終了後の照合は省略せず、実行中の照合が終わった直後に定期照合より優先して実行する。
これによりSonioxが遅延またはtimeoutしても、定期照合の滞留件数に比例してshutdownが遅れないようにする。

最後の照合成功から`USAGE_RECONCILE_MAX_STALENESS_SECONDS`を超えた場合、新しいセッションを拒否する。
実行中のセッションはローカル見積もりで上限を守り、照合失敗だけを理由に音声処理を直ちに中断しない。

Sonioxの利用ログには正常終了した要求だけが記録されるため、失敗した要求はローカル記録を残し、請求画面との日次照合対象にする。

### Soniox並行数の確認

Botは起動時に、選択したregionの`GET /v1/concurrency-limits`から現在数と上限を取得できることを確認する。
`/translate start`前に同じAPIを再取得し、projectとorganizationの両方について、現在数に`MAX_SPEAKERS_PER_SESSION`本のSTTとTTS 1 streamを加えても上限以下である場合だけ開始する。
確認結果が`SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS`より古い、または取得に失敗した場合は、推測で開始せず`SONIOX_CAPACITY_UNAVAILABLE`を返す。

この確認はSoniox側の枠を予約しないため、他のクライアントとの競合は残る。
開始後に429を受けた場合は要求を自動再送せず、`SONIOX_LIMIT_EXCEEDED`でセッションを停止する。

### 上限

| 上限 | 判定単位 | 到達時の挙動 |
| --- | --- | --- |
| 同時セッション | Guildごとに1件 | 後続の`start`を拒否する |
| 同時発話者 | セッションごとに1〜3人で設定 | 開始前は拒否し、実行中に設定上限を超えた場合はセッションを停止する |
| セッション時間 | 既定30分 | セッションを停止する |
| User月間費用 | 発話者ごと | そのUserの新しい音声を受けず、セッションを停止する |
| Guild月間費用 | Guildごと | セッションを停止し、当月の新規開始を拒否する |
| 全体月間費用 | サービス全体 | すべてのセッションを停止し、当月の新規開始を拒否する |

User月間費用には、そのUserのSTT接続と、そのUserの発話から生成したTTSの両方を含める。
セッション開始者へ他の参加者の費用をまとめて帰属させない。

Soniox ConsoleのProject Limitsにも月額上限を設定し、Bot側の全体月間上限より高い最終防衛線とする。
Botは`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`へ同じ値を保持し、`GLOBAL_MONTHLY_COST_LIMIT_MICROUSD < SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`を起動時に検証する。
この値はConsole設定の写しであり、BotからSoniox側の上限を変更しない。

月間上限、無音時間、再生キュー上限は会話ログで数値が決まっていない。
`.env.example`に入力欄を用意し、ローカル開発ではコピーした`.env.local`へ値を設定する。
値はPoCまたは運営者の予算判断で決め、本番起動時に値がない場合は起動エラーにする。

## 設定

| 設定名 | 必須 | 初期値または制約 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | 既定値なし。secretとして渡す |
| `DISCORD_APPLICATION_ID` | 必須 | Discord Application ID |
| `SONIOX_API_KEY` | 必須 | 既定値なし。secretとして渡す |
| `SONIOX_REGION` | 必須 | `us`、`eu`、`jp`のいずれか。API Keyを作成したProject regionと一致させる |
| `ALLOWED_GUILD_IDS` | 必須 | 1件以上のDiscord Guild IDをカンマ区切りで指定する |
| `ALLOWED_USER_IDS` | 必須 | セッションの開始および音声入力を許可するDiscord User IDをカンマ区切りで指定する。PoCでは運営者本人と通話相手を設定する |
| `SESSION_MAX_MINUTES` | 必須 | 初期値`30`、1以上 |
| `MAX_SPEAKERS_PER_SESSION` | 必須 | 初期値`2`、1〜3 |
| `SESSION_IDLE_TIMEOUT_SECONDS` | 必須 | 既定値なし。PoC後に決める |
| `PLAYBACK_QUEUE_MAX_MS` | 必須 | 既定値なし。PoC後に決める |
| `UTTERANCE_MAX_SOURCE_SECONDS` | 必須 | 既定値なし。PoCでTTS出力が2分未満になる値を決める |
| `TTS_MAX_INPUT_CHARACTERS` | 必須 | 既定値なし。PoCで言語とvoice別に確認する |
| `VOICE_RECONNECT_TIMEOUT_MS` | 必須 | 既定値なし。Discord PoC後に決める |
| `SONIOX_TERMINATION_TIMEOUT_MS` | 必須 | 1以上。PoC後に決める |
| `USER_MONTHLY_COST_LIMIT_MICROUSD` | 必須 | 1以上 |
| `GUILD_MONTHLY_COST_LIMIT_MICROUSD` | 必須 | User上限以上 |
| `GLOBAL_MONTHLY_COST_LIMIT_MICROUSD` | 必須 | Guild上限以上 |
| `SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD` | 必須 | Soniox Consoleで設定したProject月額上限の写し。USD表示額の100万倍で、全体上限より大きい値 |
| `STT_COST_MICROUSD_PER_HOUR` | 必須 | 現行価格を運営者が設定する |
| `TTS_COST_MICROUSD_PER_HOUR` | 必須 | 現行価格を運営者が設定する |
| `TEXT_COST_MICROUSD_PER_MILLION_CHARACTERS_UPPER_BOUND` | 必須 | 現行価格とtoken換算から安全側に設定する |
| `COST_ESTIMATE_SAFETY_PERCENT` | 必須 | `100`以上 |
| `PRICING_CONFIRMED_AT` | 必須 | `YYYY-MM-DD` |
| `PRICING_MAX_AGE_DAYS` | 必須 | 1以上。確認日からこの日数を超えた場合は起動を拒否する |
| `USAGE_RECONCILE_INTERVAL_SECONDS` | 必須 | 1以上 |
| `USAGE_RECONCILE_MAX_STALENESS_SECONDS` | 必須 | 照合間隔より大きい値 |
| `SONIOX_LIMIT_CHECK_MAX_STALENESS_SECONDS` | 必須 | 1以上。Soniox control APIの応答期限と開始前の並行数確認に使う |
| `SONIOX_STT_MODEL` | 必須 | 初期値`stt-rt-v5`、起動時に照合する |
| `SONIOX_TTS_MODEL` | 必須 | 初期値`tts-rt-v2`、起動時に照合する |
| `SONIOX_VOICE_JA` | 必須 | 利用可能なvoice ID |
| `SONIOX_VOICE_KO` | 必須 | 利用可能なvoice ID |
| `SONIOX_VOICE_EN` | 必須 | 利用可能なvoice ID |
| `TRANSLATION_TERMS_PATH` | 任意 | ホスト上の絶対パス。指定時は読めない、または不正なら起動エラー。Composeは同じファイルをコンテナ内の固定パスへ読み取り専用でマウントする |
| `SQLITE_PATH` | 必須 | 専用永続ボリューム内の絶対パス |
| `LOG_ID_HMAC_KEY` | 必須 | ログ用IDを生成するsecret。既定値なし |

起動時に全設定を一括検証する。
不正なGuild IDまたはUser ID、負数、上限の逆転、未対応region、利用不能モデル、書き込み不能DBを個別に報告し、BotをDiscordへ接続しない。

## エラー処理

| エラーコード | 条件 | 利用者への挙動 | 再試行 |
| --- | --- | --- | --- |
| `GUILD_NOT_ALLOWED` | Guildが許可リスト外 | private betaであることをephemeral表示 | 許可後のみ |
| `USER_NOT_ALLOWED` | 実行者が開始許可リスト外 | private betaであることをephemeral表示 | 許可後のみ |
| `SPEAKER_NOT_ALLOWED` | 開始時または実行中の音声チャンネルに未許可Userがいる | そのUserの音声を購読せず、セッションを開始しないか停止する | 未許可Userの退出または許可後のみ |
| `VOICE_REQUIRED` | 実行者が音声チャンネル外 | 先に参加するよう表示 | 可 |
| `TOO_MANY_SPEAKERS` | 人間が`MAX_SPEAKERS_PER_SESSION`を超えた | 設定された人数上限を超えたことを表示 | 人数減少後に可 |
| `BOT_PERMISSION_MISSING` | Discord権限不足 | 不足権限と対象チャンネルを表示 | 権限修正後に可 |
| `SESSION_ALREADY_ACTIVE` | 同じGuildで開始済み | 対象VCと開始時刻を表示 | 停止後に可 |
| `USAGE_LIMIT_REACHED` | User、Guild、全体上限 | 上限のscopeとリセット月を表示 | 翌月または設定変更後 |
| `USAGE_LEDGER_UNAVAILABLE` | SQLite書き込み失敗 | 開始を拒否するか実行中セッションを停止 | DB復旧後のみ |
| `USAGE_RECONCILIATION_STALE` | Sonioxとの照合が古い | 新しい開始を拒否する | 照合成功後 |
| `SONIOX_CAPACITY_UNAVAILABLE` | `MAX_SPEAKERS_PER_SESSION`本のSTTまたはTTS 1 stream分の空きがない | Sonioxへ接続せず開始を拒否する | 空き確認後 |
| `VOICE_CONNECTION_LOST` | Discord Voice切断 | 組み込み再接続を待ち、期限超過で停止 | `/start`で再実行 |
| `SONIOX_AUTH_FAILED` | APIキーが不正、失効、またはProject regionと不一致 | セッションを停止し、運営者へ通知 | 自動再試行しない |
| `SONIOX_BUDGET_EXHAUSTED` | Sonioxが残高不足またはProject・Organization月額上限到達をHTTP 402で返す | 全セッションを停止し、新しい開始を拒否して運営者へ通知 | 入金、上限変更、または翌月まで自動再試行しない |
| `SONIOX_LIMIT_EXCEEDED` | 429または並行数上限 | セッションを停止し、運営者へ通知 | 自動再試行しない |
| `SONIOX_STREAM_FAILED` | STT/TTSの5xx、切断、形式エラー | 再生前なら音声を破棄し、再生後なら部分再生を明示して停止 | `/start`で再実行 |
| `UTTERANCE_TOO_LONG` | 元発話時間または翻訳文字数が事前上限超過 | TTSへ送らず、短く区切って話すよう表示して停止 | 可 |
| `TTS_OUTPUT_LIMIT_REACHED` | TTS生成音声が事業者上限へ到達 | 部分再生を字幕へ明示して停止 | 短く区切って再実行 |
| `CAPTION_SEND_FAILED` | 字幕チャンネルへ投稿不能 | 音声だけで続行せずセッションを停止 | 権限修正後 |
| `PLAYBACK_BACKLOG` | 再生待ち時間が上限超過 | 同時発話を避けるよう表示して停止 | 可 |
| `UNSUPPORTED_LANGUAGE` | ペア外の発話を検出 | Userごとに1回警告し、その発話だけ読み上げない | セッションは継続 |

リアルタイム音声の途中でWebSocketを再接続すると、音声の欠落または二重読み上げが起きる。
そのためSonioxストリームの自動再送と別事業者へのフォールバックは行わず、セッションを終了して再実行を求める。

プロセス再起動後にセッションは再開しない。
起動時に`ended_at IS NULL`の`session_usage`を`PROCESS_RESTART`で終了し、残っている外部接続がないことを前提に`IDLE`から始める。

## セキュリティとプライバシー

### 認証情報

- Discord Bot TokenとSoniox API Keyはsecret managerまたは実行環境のsecretから渡す
- ローカル開発だけ`.env.local`を明示的に読み込み、Git、コンテナイメージ、配布物へ含めない
- `.env.example`には設定名と非secretの初期値だけを置き、Token、API Key、実ID、HMAC Keyを記載しない
- APIキーをDiscordコマンド、字幕、エラー、構造化ログへ出さない
- Soniox API KeyをDiscord利用者へ配布しない
- APIキーをローテーションできるよう、再デプロイだけで差し替えられる構成にする

### 認可と悪用防止

- Guild Commandの配布先とruntimeの`ALLOWED_GUILD_IDS`を一致させる
- Discordのコマンド権限だけに依存せず、すべての開始要求でGuild、実行者、全話者のruntime認可を行う
- Voice State更新と音声購読作成の両方で話者のUser IDを検証する
- 認可が完了するまでDiscord Voice、Soniox STT、Soniox TTSへ接続しない
- 上限確認とセッション排他をSoniox接続より前に行う
- 任意のSoniox endpoint、model、Discord Channel IDを利用者入力から受け取らない
- User、Guild、globalの3段階で費用を制限する
- Soniox Projectにもglobal上限より高い月額上限を設定し、Bot側の不具合時にも請求を制限する
- Sonioxの並行数を公式APIで開始前に確認し、429を正常系として扱わない

### 音声とテキスト

- Botサーバーは音声と字幕本文を永続化しない
- 音声チャンクとトークン本文を通常ログへ出さない
- SonioxのリアルタイムAPIは音声とtranscriptを保存せず、モデル学習に使用しないという現行方針を前提にする
- Sonioxとの通信にはTLS 1.2以上を使用する
- Sonioxの利用ログへ渡す`client_reference_id`は不透明IDとし、Discord IDを含めない
- Discord字幕はDiscord上に残るため、専用チャンネルの閲覧権限を制限する

Sonioxのデータ保持、学習利用、region、利用規約が変わる可能性がある。
private beta開始時と公開範囲を広げる前に公式資料を再確認し、差分があれば開始メッセージと本設計を更新する。

### 利用者への通知

`/translate start`の通常メッセージで、音声がSonioxへ送信されること、Botサーバーが音声を保存しないこと、字幕がDiscordへ残ること、停止方法を明示する。

private betaでは、Guild管理者が参加者へこの処理を事前に説明したサーバーだけを許可リストへ入れる。
一般公開前には、Userごとの明示的な参加同意と同意撤回を実装する。
同意していないUserの音声を技術的に購読しないことを、一般公開のブロッカーとする。

## 可観測性

### ログ

すべての構造化ログは`timestamp`、`level`、`event`を持つ。実装済みのイベント別フィールドは次のとおりである。

| イベント | フィールド |
| --- | --- |
| `translation_latency` | `trace_id`、`stage`、`stage_ms`、`total_ms` |
| `translation_flow` | `stage`。複数話者を識別するIDは持たない |
| `translation_runtime_failed` | HMAC化した`guild_id`、`session_id`、`reason`、`error_name`、該当時だけ`error_code` |
| その他のエラーイベント | `error_name`、該当時だけ`error_code`。処理箇所に応じてHMAC化した`guild_id`または`reason` |
| 起動・停止イベント | 件数、region、停止理由など、そのイベントに必要な非秘密情報 |

`provider_request_ref`と利用量はSQLiteへ記録するが、通常ログへは出力しない。Sonioxの`request_id`、セッション状態、言語ペアをすべてのログへ一律に付ける実装もない。

音声、原文、翻訳文、表示名、APIキーを含めない。
利用者へ表示する日本語メッセージと、運用者が分岐に使う安定したエラーコードを分ける。

### メトリクス

実装では、1発話ごとにランダムUUIDを`trace_id`として採番し、構造化ログ`translation_latency`へ次の段階を記録する。
ログには音声、原文、翻訳文、表示名、Discord IDを含めない。

| stage | 観測点 |
| --- | --- |
| `stt_endpoint` | 最後のDiscord音声packetからSoniox endpoint eventまで |
| `queue_enqueued` | endpoint確定後、FIFOへ投入した時点 |
| `queue_started` | FIFOから処理を開始した時点 |
| `caption_posted` | Discordの`再生待ち`字幕POST完了。音声開始の待機条件ではない |
| `tts_requested` | TTS要求開始 |
| `tts_connection_ready` | 新規または再利用WebSocketを送信可能と確認 |
| `tts_text_sent` | endpointで確定した翻訳文全体と`text_end`送信完了 |
| `tts_first_audio` | 最初のTTS PCM受信 |
| `playback_slot_ready` | 先行音声が完了し、この発話がDiscord再生枠を得た時点 |
| `playback_started` | Discord AudioPlayerが`Playing`へ遷移 |
| `tts_audio_end` | 1発話のTTS音声生成完了 |
| `pipeline_finished` | 再生結果を字幕へ反映して発話処理完了 |

各行の`total_ms`は最後のDiscord音声packetからの累積時間、`stage_ms`は直前に観測したstageからの経過時間である。
字幕とTTSは並行するため、区間比較ではstageの固定順を仮定せず、同じ`trace_id`の`total_ms`同士の差を使う。
`caption_posted`が`playback_started`より後に出力されることは、本設計では正常である。
TTSのstream設定、本文、PCMはすべて`stt_endpoint`後に生じるため、各区間を同じtrace内で直接比較できる。speaking startで開く本文なしのWebSocket接続は、発話別のTTS要求ではないためtraceへ記録しない。

発話の欠落箇所を本文なしで切り分けるため、`translation_flow`へ次の段階も記録する。複数話者の段階を個別追跡するログではないため、IDは付けない。

| stage | 観測点 |
| --- | --- |
| `voice_speaking_started` | Discordが話し始めを検出 |
| `voice_first_packet_received` | Botがそのspeaking burstの最初のOpus packetをPCM化してSTTへ送信 |
| `voice_packet_dropped` | `@discordjs/opus`が破損と判定した1 packetだけを破棄し、セッションは継続 |
| `voice_startup_buffer_overflow` | STT接続待ちの有界Opus bufferが件数またはbyte上限へ達し、セッションを停止 |
| `voice_speaking_ended` | Discordが話し終わりを検出。Soniox endpointとは別のイベント |
| `stt_endpoint_empty` | endpointを受けたが原文と翻訳の確定組を作れなかった |
| `stt_endpoint_finalized` | endpointで1発話をFIFOへ入れた |

2026-08-15に実Discordと実Sonioxの日韓1人通話で8発話を測った修正前baselineは次のとおりである。

| 区間 | n | p50 | p95 | 平均 |
| --- | ---: | ---: | ---: | ---: |
| 発話末尾 → endpoint | 8 | 11 ms | 274 ms | 65 ms |
| FIFO待ち | 8 | 0 ms | 3,504 ms | 917 ms |
| 字幕POST | 8 | 498 ms | 754 ms | 527 ms |
| TTS接続 | 8 | 601 ms | 753 ms | 622 ms |
| TTS本文送信 → 最初のPCM | 8 | 575 ms | 588 ms | 529 ms |
| 発話末尾 → Discord再生開始 | 8 | 1,994 ms | 5,023 ms | 2,661 ms |

修正前は、前発話の再生完了まで次処理を止めるFIFOのhead-of-line、発話ごとのTTS接続、字幕POST後にTTSを始める直列処理が支配的だった。
接続再利用、字幕とTTSの並行開始、endpointで確定済みの後続1件の生成準備でこの3点を削ったが、再生待ちがない発話でも再利用接続で715 msかかり、300 msへ届かなかった。

2026-08-16の追跡計測では、発話後の無音区間をミュートで確認した直近5発話で、発話末尾からendpointまでは10〜233 msだった。これは原因切り分けの操作であり、ミュートを通常の使用手順にはしない。
一方、後続発話が先行TTS生成の完了後に到着した1発話で、FIFO処理開始まで1,143 ms待ってからTTSに590 msかかり、再生開始が累積1,931 msになっていた。
また、TTS音声の準備後も字幕POSTを待った発話では、直近5発話の最大で183 msの追加待機があった。
この「後着発話でdrainが起きない」条件と「字幕POSTを再生条件にする」条件は解消した。
その後の直近5発話では、再生待ちなしの初回接続が1,137 ms、再利用接続が715 msだった。短い間隔で続けた2発話は先行音声の再生を待ち、4,022 msと2,521 msになった。5発話とも最終的には再生され、欠落ではなかった。

300 msへ近づけるため、2026-08-16に実Sonioxへ約2.8秒の合成日本語音声を実時間で送るPoCを行った。最初の確定原文tokenでTTS stream設定を作り、確定翻訳を発話中にTTSへ渡した2回の観測では、最後の入力PCMからendpointまで92〜221 ms、最初の翻訳PCMは最後の入力PCMより44〜62 ms前に到着した。これらは構成選択のPoCであり、p95の受入測定ではない。

その後の実Discord試験では、発話中TTS構成の2セッションがendpoint前に停止した。旧実装は確定原文の一時的な言語判定からTTS方向を作っており、後から到着した確定翻訳と不一致になる分岐を公開境界テストで再現した。確定翻訳を方向のSSOTに直した後も、通常操作と安定性のトレードオフは残るため、現行設計から発話中TTS自体を撤回した。

さらに、修正版の実Discord試験で1回の発話が最初の音声packetの約2 ms後に`TypeError`で停止し、STT利用量は2 ms、TTS要求は0件だった。`@discordjs/opus` 0.10.0のネイティブ実装は破損Opus packetを`TypeError: The compressed data passed is corrupted`として返す。これをSoniox STT障害と誤分類していたことが別の根因だった。現在はこの既知の破損エラーだけをpacket単位で破棄し、他のdecoder障害は停止させる。

発話中TTS導入前のFIFO・字幕ゲート修正を反映した当時のコンテナでは、再生まで完了した30発話について`stt_endpoint`の受付順と`playback_started`の順を照合し、順序逆転は0件だった。この過去の照合はBotが受信したendpoint順に対するFIFOを確認したものであり、現行版の遅延や複数話者の物理的な発話開始順を保証するものではない。

次の表は、`translation_latency`ログとSQLiteから運用時に集計する指標候補である。現時点ではメトリクスexporterとアラートルールを実装しておらず、表の名前をそのまま出力してはいない。

| 集計指標候補 | 用途 |
| --- | --- |
| `translation_sessions_active` | 実行中セッション数 |
| `translation_session_starts_total` | 開始数。pair、結果、拒否理由別 |
| `translation_session_ends_total` | 終了数。終了理由別 |
| `discord_voice_disconnects_total` | Discord音声受信の不安定性を検出する |
| `speech_to_final_translation_ms` | 発話から確定翻訳までの遅延 |
| `final_translation_to_tts_audio_ms` | 確定翻訳から最初のTTS音声までの遅延 |
| `speech_to_playback_ms` | 発話区切りからDiscord再生開始までの全体遅延 |
| `playback_queue_wait_ms` | `playback_slot_ready.total_ms - queue_enqueued.total_ms`から導出するFIFO全体の待ち時間 |
| `soniox_requests_total` | API、結果、error_type別の要求数 |
| `soniox_cost_microusd` | User、Guild、global別の見積もりと実額 |
| `usage_reconciliation_lag_seconds` | 利用ログ照合の遅れ |

private betaの運用基盤を決める際に、APIエラー率、p95遅延、再生キュー上限、月間費用の80%と100%、照合遅延のアラートを設定する。リポジトリ内にアラート設定はまだない。

## 検証方針

### PoC

private betaの受入前に、次の順で公開境界を検証する。

1. テストGuildで`@discordjs/voice`から3人分の音声を30分継続受信し、User IDとOpusパケットを対応づけられることを確認する
2. 保存済みの同じ10分音声をSonioxへ送り、日韓、日英、韓英の両方向で原文、翻訳、TTS、実料金を測る
3. マイク入力からSoniox STT、確定トークン、Soniox TTS、スピーカー出力までを接続し、全体遅延を測る
4. Discord Voiceの受信から同じVCへの再生までを接続し、翻訳ループ、同時発話、切断、停止を確認する
5. 設定voiceと言語ごとに長文をTTSへ送り、2分未満に収まる`UTTERANCE_MAX_SOURCE_SECONDS`と`TTS_MAX_INPUT_CHARACTERS`を決める

PoCでは次を記録する。

- 発話区切りから翻訳音声が聞こえ始めるまでのp50、p95、最大値
- 原文の認識結果と翻訳結果
- `VALORANT`、`ult`、`gg`などの用語一致
- 日本語、韓国語、英語それぞれの読み上げ自然さ
- STT接続時間、TTS生成時間、Soniox利用ログ上の実料金
- Discord音声の受信間隔、再接続回数、音声デコードエラー

stableの`@discordjs/voice` 0.19.2が公開する受信streamはOpus payloadの`Buffer`であり、RTP sequence、timestamp、SSRCを公開しない。
そのため、この固定バージョンの公開APIだけでは真の欠落パケット数を測定できない。
非公開hookには依存せず、受信間隔の異常、decoder error、切断を代替指標として記録し、RTP metadataがstable APIへ入った後に欠落数の計測を追加する。

### 統合テスト

振る舞い変更は、内部クラスのモックではなく、次の公開境界から先に失敗させる。

- Slash Command入力からDiscord応答まで
- Opus音声fixture入力から、Sonioxクライアント境界へ渡すPCMと、破損packetだけを破棄して次のpacketを受ける境界まで
- Soniox token fixture入力から、確定原文の言語ラベルが確定翻訳と食い違う場合も含め、endpointで確定する原文・翻訳と、endpoint前にTTS要求を作らないことまで
- TTS PCM fixture入力から、endpoint確定後のTTS生成、同時TTS 1本の制約、字幕POSTを待たない音声開始、`Playing`前の`Idle`を成功扱いしないこと、FIFO再生順、再生待ち上限、後続失敗で先行再生を中断しないことまで
- TTS WebSocket fixtureから、本文を送らない接続ウォームアップ、接続再利用、待機切断後の再接続、`audio_end`、`terminated`、`cancel`、`max_audio_duration_reached`と要求状態まで
- TTS WebSocket fixtureから、`null`、型不正、base64不正の応答をprocess例外にせずstream失敗へ変換することと、接続待ちを`AbortSignal`で終了できることまで
- 3言語ペアの両方向から、確定原文・確定翻訳の組み立てとSonioxの双方向設定まで
- セッション開始と停止から、SQLiteへ残る利用量と終了理由まで
- 未許可Guild、未許可の実行者または話者、費用上限超過、並行数不足、長すぎる発話から、不要なSoniox接続が0件であることまで

純粋なトークン連結、金額計算、状態遷移表だけはユニットテストで補完する。
重要な完了証拠は、実Discord GuildとSoniox APIを使うE2Eとする。

### 受入シナリオ

```text
前提:
  許可済みGuildで、日本語話者と韓国語話者が同じVCへ参加している

操作:
  /translate start pair:ja-ko
  日本語話者が「今日VALORANTやる？」と話す

期待:
  韓国語の確定翻訳だけがSoniox TTSへ渡る
  同じVCで韓国語音声が再生される
  字幕チャンネルに発話者、原文、韓国語訳、再生状態が1件投稿される
  Botの韓国語音声は再度STTへ送られない
  session_usageとmonthly_usageへ利用量が加算される
```

## 運用

### 初期セットアップ

1. [Soniox Console](https://console.soniox.com/)で、このBot専用のProjectを作成する
2. アカウントで利用可能なProject regionを選び、Project Limitsへ月額上限を設定してから、そのProject専用のAPI Keyを作成する。日本regionが選択肢にない場合は、Soniox Supportへregional deploymentの利用を申請するか、利用可能なregionを選ぶ
3. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationとBotを作成し、`Public Bot`をOFF、Installation Contextsを`Guild Install`のみ、Install Linkを`None`にする
4. OAuth2 URL Generatorで`bot`と`applications.commands`を選び、`View Channels`、`Send Messages`、`Connect`、`Speak`だけを指定したURLから、Application OwnerがBotをテストGuildへ追加する。生成URLは配布せず、Install Linkは`None`のままにする
5. テストGuildだけへSlash CommandをGuild Commandとして登録する
6. `cp .env.example .env.local && chmod 600 .env.local`を実行し、Bot Token、Application ID、Soniox API Key、許可するGuild ID、運営者本人と通話相手のUser IDを入力する
7. `LOG_ID_HMAC_KEY`用に`openssl rand -hex 32`を実行し、出力を`.env.local`へ保存する
8. Soniox ConsoleのProject月額上限と`SONIOX_PROJECT_MONTHLY_BUDGET_MICROUSD`が一致し、Bot側の全体月間上限がそれより低いことを確認する。Consoleで`$5`なら設定値は`5000000`とする

Token、API Key、実ID、HMAC Keyはチャット、Issue、Git、コンテナイメージへ貼り付けない。
ローカル以外では`.env.local`を転送せず、デプロイ環境のsecret機能から同じ設定名を注入する。

### デプロイ

- Linux上で単一のDockerコンテナを動かす
- SQLiteは専用の永続ボリュームへ置く。運用ログは標準出力へ出し、Dockerまたは収集基盤側で保存期間とrotationを設定する
- コンテナにはNode.js、Opus native addon、Botコードだけを含め、FFmpegは含めない
- secretはイメージまたはGitへ含めず、デプロイ環境から注入する
- Botプロセスは1レプリカに固定する
- コンテナからDiscord Voice用UDP、Discord API、Soniox APIへ接続できることをデプロイ前に確認する

複数レプリカではGuildごとの排他、音声接続、SQLiteの整合性が壊れるため、MVPでは起動を1レプリカに限定する。
水平分散が必要になった時点で、セッション所有権と利用量台帳を外部ストアへ移す。

### 起動と停止

起動時は、設定検証、SQLite migration、未終了セッションの回収、Sonioxモデル確認、利用ログ照合、Discord接続の順に行う。
途中で失敗した場合はDiscordへReadyを通知せず、プロセスを非ゼロで終了する。

`SIGTERM`では新しいコマンドを拒否し、接続中のVoice待機とTTS合成をキャンセルし、全セッションを`PROCESS_SHUTDOWN`で停止してからDiscordとSQLiteを閉じる。Composeは30秒の停止猶予を与える。
終了期限を超えた場合も、音声や字幕本文をファイルへ退避しない。

### DB migration

SQLiteのschema versionを管理し、起動時にtransaction内で前方migrationを適用する。
破壊的migrationを行う場合は、停止中にDBファイルを復旧可能な場所へバックアップしてから実行する。

## 検討した代替案

| 案 | MVPで採用しない理由 | 再検討条件 |
| --- | --- | --- |
| OpenAIまたはGeminiの一体型音声翻訳 | 会話ログの比較ではSonioxより原価が高く、用語調整やpreview状態に制約があった | PoCの遅延が会話ログの`2〜3秒`側に寄り、一体型で明確に改善する |
| ローカルWhisper、LLM翻訳、外部TTS | GPU運用と3段階の障害点が増える。音声出力を含むとTTS費用が支配的で、削減幅が小さい | 字幕専用モードまたは大規模利用でSTT原価が支配的になる |
| 字幕だけのMVP | 利用者は翻訳音声を含む方式を選んでおり、コア体験が変わる | 利用者テストで音声が不要だと確認できる |
| 3言語同時翻訳 | 同じVCに複数翻訳音声が流れ、聞き手別に配信できない | 言語別VCまたは聞き手別音声経路を設計できる |
| BYOK | OAuth、Web UI、秘密情報の暗号化保存が必要になる | 一般公開時に運営者負担の上限では需要を支えられない |
| 音声と字幕の保存 | プライバシー、削除、閲覧認可の範囲が広がる | 利用者が明示的に履歴機能を求め、保持方針を合意できる |
| Soniox障害時の自動fallback | 同じ発話の二重再生、品質差、別事業者へのデータ送信が発生する | 事業者切替への同意、重複防止、品質基準を別設計で定義する |

## 実装順序

1. `/translate start`と`stop`、言語ペア、Guildごとの状態遷移を実装する
2. User別STT、確定トークン、TTS、FIFO再生、字幕を接続する
3. SQLiteの利用量台帳、上限、Soniox利用ログ照合を追加する
4. エラー通知、構造化ログ、計測点、graceful shutdownを追加する
5. 実Discord Guildで音声受信とSoniox音声往復のPoCを行い、遅延、安定性、料金を測る
6. 3言語ペアと30分E2Eを行い、MVP完了条件を確認する

実装コードと認証情報を使わない統合テストは作成済みである。
実Discordと実Sonioxの日韓1人通話では音声往復と修正前の遅延区間を確認済みである。実Sonioxの合成音声PoCでは発話中TTSの遅延効果も確認したが、通常操作と安定性を優先して現行実装から撤回した。endpoint後TTS版の実Discord遅延、複数人通話（3人を含む）、日英・韓英、30分継続、料金の受入確認は未実施である。
残るPoCで音声受信が安定しない場合はprivate betaを開始させない。遅延目標はミュートなしの実Discord計測を根拠に再設定する。

## 参考

### 入力資料

- [discord_realtime_translation_chat.zip](../discord_realtime_translation_chat.zip)
  - SHA-256: `662b2f367040321ad67669d7290dc383900e54835030d585f579479bf68b1c76`
- 章立てと粒度の参照: [design-structure-sample.md](./reference/design-structure-sample.md)

### 公式資料

- [Soniox: Real-time speech-to-speech translation](https://soniox.com/docs/translation/sts-translation)
- [Soniox: Speech-to-speech translation demo](https://soniox.com/docs/demo-apps/soniox-speech-to-speech-translation)
- [Soniox examples: speech-to-speech translation pre-warming](https://github.com/soniox/soniox_examples/blob/75a1aac9c3a354b7f286345fb99f31d2beff55c2/apps/soniox-speech-to-speech-translation-demo/main.py)
- [Soniox: Speech-to-text translation](https://soniox.com/docs/translation/stt-translation)
- [Soniox: STT WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)
- [Soniox: Real-time Text-to-Speech](https://soniox.com/docs/tts/rt/real-time-generation)
- [Soniox: TTS WebSocket API](https://soniox.com/docs/api-reference/tts/websocket-api)
- [Soniox: TTS connection keepalive](https://soniox.com/docs/tts/rt/connection-keepalive)
- [Soniox: TTS limits and quotas](https://soniox.com/docs/tts/rt/limits-and-quotas)
- [Soniox Node SDK: multi-stream connection](https://soniox.com/docs/sdk/node-SDK/tts/realtime-speech-generation#multi-stream-connection)
- [Soniox JavaScript SDK: TTS types](https://github.com/soniox/soniox-js/blob/8661b750e6cbd0a2c382f6b79c7c198e29c4a2b0/packages/core/src/types/tts.ts)
- [Soniox JavaScript SDK: realtime TTS implementation](https://github.com/soniox/soniox-js/blob/8661b750e6cbd0a2c382f6b79c7c198e29c4a2b0/packages/core/src/realtime/tts.ts)
- [Soniox: TTS models](https://soniox.com/docs/tts/models)
- [Soniox: Endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection)
- [Soniox: Supported translation languages](https://soniox.com/docs/translation/supported-languages)
- [Soniox: Language restrictions](https://soniox.com/docs/stt/concepts/language-restrictions)
- [Soniox: Context](https://soniox.com/docs/stt/concepts/context)
- [Soniox: API pricing](https://soniox.com/pricing)
- [Soniox: Usage logs](https://soniox.com/docs/guides/usage-logs)
- [Soniox: Concurrency limits](https://soniox.com/docs/guides/concurrency-limits)
- [Soniox: Get started and create an API key](https://soniox.com/docs/translation/get-started)
- [Soniox: Project monthly budget errors](https://soniox.com/docs/api-reference/errors#project-monthly-budget-exhausted)
- [Soniox: Data residency and Project regions](https://soniox.com/docs/data-residency)
- [Soniox: Security and privacy](https://soniox.com/docs/security-and-privacy)
- [discord.js voice](https://discord.js.org/docs/packages/voice/stable)
- [discord.js voice: AudioPlayer](https://discord.js.org/docs/packages/voice/0.19.2/AudioPlayer%3AClass)
- [discord.js guide: Audio player](https://discordjs.guide/voice/audio-player)
- [discord.js stable](https://discord.js.org/docs/packages/discord.js/stable)
- [Discord: Voice Connections](https://docs.discord.com/developers/topics/voice-connections)
- [Discord: Application Commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord: Building your first Bot](https://docs.discord.com/developers/quick-start/getting-started)
- [Discord: Application installation contexts and links](https://docs.discord.com/developers/resources/application)
- [Discord: Public and private Bot setting](https://support-dev.discord.com/hc/en-us/articles/21204493235991-How-Can-Users-Discover-and-Play-My-Activity)
- [Discord: Find User and Server IDs](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)

公式資料と本設計が矛盾する場合は、実装時点の公式資料を優先し、差分と影響を本設計へ反映してから実装する。
