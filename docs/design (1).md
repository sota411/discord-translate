# Design

## 背景

開発・運用の中で、注文IDやショップIDといった一意な値を起点に状況を確認する場面が頻繁に発生する。
ヒアリングでは以下の声が挙がっている。

- 〇〇ID（一意の値）をもとに確認したり、別チームとやりとりすることが多い
- そのIDのステータスをbase_adminで確認するのがいちいち手間
- コマンド体系が人間向けで、機械可読な取得が難しい（agentネイティブではない）

現状の確認フローは概ね次の通りで、ブラウザ操作・画面遷移・環境の切り替えが毎回発生する。

1. base_admin を開く
2. 対象環境にログインする
3. 該当タブを選択する
4. 検索画面でIDを入力する
5. 目的の情報が載っている箇所までスクロールする
6. 別の情報が必要になったら `3` に戻る

1回あたりの所要時間は短いが、発生頻度が高く、ターミナルやエディタからの離脱を強制されることがコストになっている。

## 目的

一意なIDを渡すだけで、**ターミナル上で必要な情報が揃う状態**をつくる。

### ゴール

- 注文ID・ショップID等から、関連情報をワンコマンドで取得できる
- 人間が読む用途と、機械（スクリプト・AIエージェント）が読む用途の両方に対応する
- 他チームが参照可能なリソース種別を追加できる拡張性を持つ

### 非ゴール（今回のスコープ外）

- データの更新・削除
- base_adminの完全な代替
- 個人情報をCLIの取得結果やログへ含めること
- 環境の起動・デプロイ等の操作系コマンド

## 技術構成

| 用途 | 技術 |
| --- | --- |
| CLI | Go、Cobra |
| Chrome操作 | Chrome DevTools Protocol、chromedp |
| CLI内部通信 | Unix domain socket |
| ビルドと配布 | GitHub Actions、GoReleaser |

## コマンド設計

### 基本形

`base <command> <resource> <id> [flags]`

リソースを扱うコマンドはこの形式に揃える。
この形式はK8sのkubectlでも採用されている。
<https://kubernetes.io/docs/reference/kubectl/>

ex. > IDの形式（桁数・プレフィックス等）から種別を推測して該当コマンドにディスパッチする。
一覧取得ではIDを省略し、複数IDを扱うコマンドではIDを繰り返し指定する。

### 想定コマンド

現時点で想定しているコマンドを示す。この一覧は網羅ではなく、実装する機能に合わせて追加する。

| コマンド | 用途 |
| --- | --- |
| `base --help` | コマンド一覧と概要を表示する |
| `base version` | CLIのバージョンを表示する |
| `base update` | 新しいバージョンを確認し、更新があれば適用する |
| `base status` | Chrome接続とbase_admin認証の状態を表示する |
| `base get order <order-header-id>...` | 注文ヘッダーIDから注文情報を入力順に取得する |
| `base get order <order-header-unique-key>...` | 注文ヘッダー一意キーから注文情報を入力順に取得する |
| `base get shop <shop-id>...` | ショップ情報を入力順に取得する |
| `base get user <user-id>...` | ショップ利用者情報を入力順に取得する |

状態や業務データを返すコマンドは`--json`に対応し、入力待ちを行わない。

### 接続と状態

`base status`はChromeへの接続可否とbase_adminの認証状態を返す。
AIエージェントは処理前にこのコマンドを実行し、前回の実行状態に依存せず取得可能か判断する。
ChromeとのCDP接続が既に確立されている場合は、バックグラウンドプロセスが保持している接続を再利用し、新しい接続を作成しない。
人間向けの出力には、選択中の環境と接続先のoriginも含める。

`--json`では`environment`、`origin`、`ready`、`browser`、`authentication`、`login_url`、`next_action`を返す。
`environment`と`origin`は選択中の環境と接続先を表す。`browser`は`connected`または`disconnected`、`authentication`は選択中の環境について`authenticated`、`unauthenticated`、`unknown`のいずれかとする。`ready`が`true`のときは`login_url`と`next_action`を`null`、`false`のときは`next_action`を必須とする。`login_url`は選択中の環境でログインが必要な場合だけURLを返す。
取得できる状態ではexit code `0`、接続やログインが必要な状態ではexit code `1`とする。

### 対象環境

Chromeを利用するコマンドは、環境変数`BASECLI_ENV`でbase_adminの接続先を切り替える。
`BASE_ENV`は会社内の複数プロジェクトに共通する環境を表す名前に見えるため使用しない。このCLIの設定であることを明示するため、`BASECLI_ENV`とする。
`BASECLI_ENV`には接続先を表す環境名だけを設定する。サブコマンド、リソース、IDは環境変数に含めず、CLIのコマンドと引数として渡す。
初期実装では`local`を既定値とし、`BASECLI_ENV`を指定しない場合も`local`へ接続する。
対応する環境名は`local`、`dev_green`、`stg`、`prod`とし、対応済みの環境とoriginの組み合わせだけをコードへ列挙する。
ほかの色環境は、利用が必要になった時点でoriginとともに追加する。
現在のバイナリが対応していない値を指定した場合は、別の環境へフォールバックせず、不正な引数としてexit code `2`で終了する。

各環境への対応後は、接続先を次のように指定する。
この書式で環境変数へ設定される値は`local`、`dev_green`、`stg`、`prod`のいずれかであり、空白以降はCLIのコマンドと引数である。

```sh
BASECLI_ENV=local base get shop shop_example_001
BASECLI_ENV=dev_green base get shop shop_example_001
BASECLI_ENV=stg base get order order_example_001
BASECLI_ENV=prod base get order order_example_001
```

CLIは環境間のデータコピーやマスキングの有無を前提にしない。
選択した環境のbase_adminだけを参照し、同じIDを別の環境で自動検索しない。
各CLIプロセスは選択した環境をバックグラウンドプロセスへ渡すため、環境を切り替えてもCDP接続を作り直さない。

### 出力方針

注文情報の既定出力は、注文状態の一次調査に必要な情報へ限定する。
人間向けとLLM向けで同じデータを使用し、表示形式だけを切り替える。
人間向けとJSONのどちらにも、取得元の環境を含める。
接続先のoriginは環境から一意に決まるため、取得結果には含めず、接続診断を行う`base status`だけに含める。

出力する情報は次の通り。

- 注文ID、注文番号、店舗ID
- 注文、配送の状態
- 支払方法、3Dセキュア状態
- 配送方法、追跡番号の登録有無
- 商品金額、送料、各種手数料、注文合計
- 商品単位のorder ID、item ID、数量、状態
- 注文、発送、キャンセル、作成、更新日時と発送期限
- base_adminの「警告理由」に表示された項目名

次の情報は出力しない。

- 氏名、住所、メールアドレス、電話番号
- AppユーザーID、決済アカウントID
- IPアドレス、ユーザーエージェント
- カード名義、カード番号の末尾
- 備考、商品名、編集履歴や取引履歴の本文
- 追跡番号
- 決済や取引を外部システムと照合できる識別子

個人情報をマスク表示するオプションは設けず、必要な場合はbase_adminで確認する。
ページ内の抽出処理は、上記の許可項目だけをCLIへ返す。
警告理由はCLI独自のコードへ変換せず、base_adminの表示値を`warnings`へ格納する。
現在のbase_adminは、`full_name`や`ip_country`のように監視条件へ一致した項目名だけを警告理由として表示し、実際に一致した氏名、住所、IPアドレスなどの値は表示しない。
CLIは`c_c_country`、`full_address`、`full_name`、`ip_country`と、base_adminが理由を取得できない場合に表示する`警告理由が存在しません`だけを受け付け、変換せずに出力する。それ以外の文字列は出力せず、画面仕様の変更としてエラーにする。
警告がない場合、JSONでは`warnings`を空配列、人間向けでは`警告: なし`と表示する。

参考:

- <https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/>
- <https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/>

### 出力（人間向け）

フラグを指定しない場合は、人間が状態を確認しやすい形式で出力する。
以下の例では、実在しない注文情報を使用している。

```text
$ base get order order_example_001

環境: local
注文 order_example_001 [未発送]
注文番号: EXAMPLE-0001
店舗ID: shop_example_001

決済
  方法: クレカ
  3Dセキュア: 確認済み

配送
  状態: 未発送
  方法: 宅配便
  追跡番号登録: なし
  発送期限: 2030-01-15

金額
  通貨: JPY
  商品: 2,000円
  送料: 500円
  注文合計: 2,500円

手数料
  サービス利用料: 75円
  決済手数料: 130円

商品
  ORDER ID       ITEM ID        単価    数量  小計    状態
  line_example_1 item_example_1 1,000円 2     2,000円 未発送

日時
  注文: 2030-01-01 12:00:00 JST
  発送: なし
  キャンセル: なし
  作成: 2030-01-01 12:00:00 JST
  更新: 2030-01-01 12:00:00 JST

警告:
  - full_name
  - ip_country
```

### 出力（LLM向け）

`--json`を指定した場合の出力例を示す。
IDが1件の場合も、トップレベルは配列とする。

```json
[
  {
    "schema_version": 1,
    "resource": "order",
    "environment": "local",
    "currency": "JPY",
    "OrderHeader": {
      "id": "order_example_001",
      "unique_key": "EXAMPLE-0001",
      "shop_id": "shop_example_001",
      "dispatch_status": "ordered",
      "payment": "creditcard",
      "three_d_secure": "verified",
      "delivery_methods": [
        "宅配便"
      ],
      "tracking_number_registered": false,
      "shipping_deadline": "2030-01-15",
      "subtotal": 2000,
      "shipping_fee": 500,
      "order_total": 2500,
      "service_fee": 75,
      "payment_fee": 130,
      "ordered": "2030-01-01T12:00:00+09:00",
      "dispatched": null,
      "cancelled": null,
      "created": "2030-01-01T12:00:00+09:00",
      "modified": "2030-01-01T12:00:00+09:00"
    },
    "Order": [
      {
        "id": "line_example_1",
        "item_id": "item_example_1",
        "price": 1000,
        "amount": 2,
        "total": 2000,
        "status": "ordered"
      }
    ],
    "warnings": [
      "full_name",
      "ip_country"
    ]
  }
]
```

`schema_version`、`resource`、`environment`はCLIが付与するメタデータである。
`currency`はbase_adminの通貨表記をCLIがISO 4217の通貨コードへ変換した値である。
`OrderHeader`と`Order`はbase_adminのCakePHP model aliasであり、DOMから同名の値を取得できるキーにはbase_adminの名前を使う。
`three_d_secure`、`delivery_methods`、`tracking_number_registered`、`shipping_deadline`、`subtotal`、`order_total`、`service_fee`、`payment_fee`は、画面表示からCLIが生成するキーである。

### JSON出力仕様

JSON出力には次のルールを適用する。

#### 標準出力とエラー

- `base get <resource> <id>... --json`の正常終了時は、IDの件数にかかわらず単一のJSON配列を標準出力へ出力する。
- `base status --json`は、取得可否にかかわらず単一の状態オブジェクトを標準出力へ出力する。接続やログインが必要な状態は実行エラーではなく、標準エラーへは何も出力しない。
- `base get <resource> <id>...`でbase_adminの認証切れを検出した場合は認証要求エラーとし、標準出力には何も出力せず、ログインURLと再実行方法を標準エラーへ出力してexit code `1`で終了する。
- JSONにはANSI装飾や診断メッセージを含めない。
- コマンドの実行エラーは標準エラーへ出力し、標準出力には何も出力しない。
- `--json`指定時のエラーはJSONで標準エラーへ出力し、`environment`、エラーコード、原因、再試行可否、次に行う操作、失敗した対象を含める。認証要求エラーの場合は`login_url`も含める。
- 人間向けのエラーには、失敗したIDまたは不正な引数と、次に行う操作を文章で示す。

複数IDは入力順に逐次取得し、全件の取得と検証が成功してから標準出力へ書き出す。
1件でも失敗した場合はその時点で後続IDの処理を中止し、取得済みの結果も出力しない。

#### exit code

exit codeは次の3種類に固定する。

| exit code | 意味 |
| --- | --- |
| `0` | コマンドが成功した。`base status`の場合はデータを取得できる状態である |
| `1` | コマンドの実行に失敗した、または`base status`が接続や認証の準備が必要な状態を返した |
| `2` | コマンド、リソース種別、ID、フラグ、環境の指定が不正である |

取得コマンドは読み取りだけを行い、同じコマンドを再実行しても業務データを変更しない。
ログインや接続設定が必要な場合も入力待ちにせず、URLまたは操作手順を返して終了する。

#### 金額

- base_adminで`円`と表示される金額は、ISO 4217の通貨コードを`JPY`とし、1円を1とする最小単位の整数へ変換する。
  - JSONでは注文単位の通貨コードをトップレベルの`currency`へ格納し、`OrderHeader`と`Order`の金額項目には最小単位の整数だけを格納する。
  - 人間向けでは`通貨: JPY`を表示し、各金額には`円`を付ける。
  - `円`以外の通貨表記や整数へ一意に変換できない金額は、推測して出力せずエラーにする。
- `shipping_fee`と商品単位の`price`、`total`は、対応するセル全体が1つの円額であることを確認してから整数へ変換する。
- `subtotal`は、検証済みの全商品行の`total`を合計した値とする。
- `order_total`は「合計」行の先頭に表示される円額とする。同じセル内の括弧付き金額と「購入者決済手数料を含む」金額は採用しない。
- `service_fee`と`payment_fee`は、対応する行の先頭から最初の`円`までに表示される金額とし、括弧内の料率と固定額は採用しない。画面上の値が`-`の場合は、手数料が発生していないものとして`0`を出力する。
- `order_total`は購入者へ請求する注文合計であり、`service_fee`と`payment_fee`を含まない。
  - 合計値の意味を固定し、手数料を含むかどうかを利用側が推測せずに済むようにするためである。

#### 日付と日時

- `OrderHeader.shipping_deadline`は、時刻を含まない`YYYY-MM-DD`形式で表す。
  - 発送期限は日付だけで管理するためである。
- 注文日時などの時刻を持つ値は、base_adminと同じ日本標準時（JST、`Asia/Tokyo`）で表す。
  - JSONではRFC 3339形式の`YYYY-MM-DDTHH:mm:ss+09:00`、人間向けでは`YYYY-MM-DD HH:mm:ss JST`とし、どちらもJSTであることを出力から判別できる形式にする。
  - base_adminの画面から取得した日時を`Asia/Tokyo`として解釈し、UTCへ変換せずに画面とCLIの時刻表記をそろえる。

#### 状態や支払方法の値

- `status`や`payment`などは、フィールドごとに定めた値だけを出力する。
  - CLI、スクリプト、LLMが表記ゆれを考慮せずに判定できるようにするためである。
- 注文状態と商品状態は同じ変換表を使う。人間向けではbase_adminの表示値をそのまま使う。

| base_adminの表示値 | JSONの`OrderHeader.dispatch_status` / `Order.status` |
| --- | --- |
| `キャンセル` | `cancelled` |
| `発送完了` | `dispatched` |
| `未発送` | `ordered` |
| `配送中` | `shipping` |
| `入金待ち` | `unpaid` |
| `対応開始前` | `unshippable` |

- 支払方法は次の表示値だけを受け付け、対応するbase_adminの内部値へ変換する。人間向けではbase_adminの表示値をそのまま使う。

| base_adminの表示値 | JSONの`payment` |
| --- | --- |
| `クレカ` | `creditcard` |
| `銀振` | `base_bt` |
| `コンビニ` | `cvs` |
| `後払い` | `atobarai` |
| `銀振(ショップ)` | `bt` |
| `代引` | `cod` |
| `ドコモ ケータイ払い` | `carrier_01` |
| `au かんたん決済` | `carrier_02` |
| `ソフトバンクまとめて支払い・ワイモバイルまとめて支払い` | `carrier_03` |
| `コイン決済` | `coin` |
| `PayPal` | `paypal` |
| `Amazon Pay` | `amazon_pay` |
| `PAY ID あと払い` | `bnpl` |
| `PAY ID 3回あと払い` | `bnpl_installment` |
| `PayPay` | `paypay` |

- 3Dセキュア状態は次の3種類だけを受け付ける。「対象外」と「データなし」は区別しない。

| base_adminの表示値 | JSONの`three_d_secure` | 人間向け |
| --- | --- | --- |
| `attempted` | `attempted` | `試行済み` |
| `verified` | `verified` | `確認済み` |
| 空欄 | `null` | `なし` |

- 配送方法は、base_adminの「配送方法詳細」にある「配送方法名」を画面の表示順に取得し、JSONでは`delivery_methods`配列へ格納する。人間向けでは1件ずつ表示し、配送方法詳細がない場合はJSONで空配列、人間向けで`なし`と表示する。
- 状態、支払方法、3Dセキュア状態について、CLIが対応していない値を取得した場合は、その値を`unknown`へ置き換えず、エラーを標準エラーへ出力して非ゼロの終了コードで終了する。
  - 取得元に新しい値が追加された場合やCLIの変換処理に漏れがある場合に、未対応の値を正常な結果として扱わないためである。

#### 値がない場合

- 各項目について、値を必須とするか、`null`を許可するか、配列の場合に0件を許可するかを出力スキーマで定義する。
  - 項目ごとの扱いを出力例から推測せずに実装できるようにするためである。
- 出力スキーマで必須と定めた項目を取得できなかった場合は、`null`へ置き換えず、エラーを標準エラーへ出力して非ゼロの終了コードで終了する。
  - 必須項目の取得失敗を、仕様上値が存在しない状態として扱わないためである。
- 出力スキーマで値がなくても正常と定めた項目は、値がない場合もキーを省略しない。単一の値がない場合は`null`、一覧が0件の場合は空配列を出力する。
  - 例えば、未発送のため発送日時がない場合は`"dispatched": null`、商品が0件の場合は`"Order": []`となる。キーの欠落と値がない状態を区別し、JSONの構造を一定に保つためである。

## データ取得経路

### 方針

利用者が普段使っているChromeへCDPで接続し、Chrome内のbase_adminセッションを利用する。
CLIへ認証情報やCookieをコピーしない。

Chromeを利用するコマンドは、CLIと同じバイナリのバックグラウンドプロセスを内部で自動起動する。
利用者向けのプロセス管理用コマンドは追加しない。
各CLIプロセスはローカルソケット経由でバックグラウンドプロセスへ処理を依頼する。
バックグラウンドプロセスはOSの利用者ごとに1つだけ起動し、起動時の排他ロックによって複数プロセスの同時起動を防ぐ。
ローカルソケットが存在しても接続できない場合は、ソケットの所有者と排他ロックの解放を確認してから、残っているソケットを削除して起動し直す。

バックグラウンドプロセスは`chromedp`を使ってChromeへ接続する。
Chrome 144以降のauto-connectと同様に、利用者は`chrome://inspect/#remote-debugging`でremote debuggingを有効にする。
Chromeは動的に割り当てたローカルポートとブラウザー単位のWebSocketパスを、ユーザーデータディレクトリ内の`DevToolsActivePort`ファイルへ出力する。
バックグラウンドプロセスはこのファイルを読み、`ws://127.0.0.1:<port><path>`形式の接続先を組み立ててchromedpへ渡す。
接続後はCDPのWebSocketを保持し、CLIプロセスが終了しても切断しない。
各処理では一時targetだけを作成して閉じ、ChromeとのCDP接続は後続のコマンドで再利用する。
利用者が固定の`--remote-debugging-port`を付けてChromeを起動する手順は採用しない。

Chromeが終了した場合やCDP接続が切れた場合は、バックグラウンドプロセスを終了してローカルソケットを削除する。
バックグラウンドプロセス自身はCDPへ再接続せず、次にChromeを利用するコマンドが実行されたときに新しいプロセスを起動する。
バックグラウンドプロセスが異常終了してローカルソケットが残った場合は、次のコマンドが所有者と排他ロックを検証して削除する。
base_adminの認証が切れた場合はCDP接続を維持したまま、ログインURLと再実行方法を返す。
初回接続でChrome側の許可が必要な場合は、CLIで入力を待たず、Chromeで許可してからコマンドを再実行する手順を返す。
バックグラウンドプロセスはChromeへの接続要求を保持し、許可された後のコマンドから確立済みの接続を使う。
Chromeが起動していない場合、remote debuggingが無効な場合、接続を拒否された場合は、原因と次に行う操作をCLIへ返して終了する。

PoCでは次の点を検証する。

- `DevToolsActivePort`から検出した接続先をchromedpへ渡して接続できる
- CLIプロセスを複数回実行しても、バックグラウンドプロセスが同じCDP接続を再利用する
- 一時targetを閉じてもCDP接続が切れず、Chromeの接続許可が初回だけで済む
- CLIプロセスが終了した後もChromeの接続許可待ちを継続し、許可後の再実行で接続済みになる
- Chromeへ接続できない場合は一時targetを作らず、`status`では状態を、`get`では実行エラーを返す
- 許可したoriginとパスのDOMから、出力を許可した項目だけを抽出できる
- base_adminの認証切れ時にCDP接続を維持してログインURLを返し、ログイン後の再実行で取得できる
- `BASECLI_ENV`の未指定時は`local`を選び、未対応の値ではChromeへ接続せずexit code `2`で終了する
- 状態と取得結果に、選択した環境が含まれる
- 選択した環境とは異なるoriginへ遷移した場合は、別の対応済み環境であっても取得を中止する
- 複数のCLIプロセスを同時に実行してもバックグラウンドプロセスが1つだけ起動する
- 異常終了後に残ったローカルソケットを検出し、次のコマンドで復旧できる
- Chromeを終了した場合に、バックグラウンドプロセスとローカルソケットが残らない

### 処理の流れ

1. Cobraで環境、リソース種別、IDを検証する
2. 選択した環境を含む要求をローカルソケットへ送り、バックグラウンドプロセスが起動していない場合は自動起動する
3. CDP接続が確立されていない場合は、バックグラウンドプロセスが`DevToolsActivePort`から接続先を検出してChromeへ接続する
4. Chromeへ接続できない場合や許可待ちの場合は一時targetを作らず、`status`には接続状態と次に行う操作を、`get`には実行エラーを返して終了する
5. 確立済みのCDP接続で、CLI用の一時targetを作成する
6. 選択した環境に対応するoriginとパスをコード内の一覧から解決し、一時targetでbase_adminの詳細画面をGETする
7. ログイン画面へ遷移した場合は認証要求エラーとし、遷移しなかった場合はレンダリング済みDOMから出力を許可した項目だけを取り出す
8. 項目を取得した場合は出力モデルとして検証する
9. 成否にかかわらず一時targetを閉じ、ChromeとのCDP接続は切断しない
10. バックグラウンドプロセスが結果をローカルソケットへ返し、CLIが人間向け表示またはJSONへ変換する

リソースごとの取得先は次の通り。

| リソース | IDの意味 | base_adminのパス |
| --- | --- | --- |
| `order` | 注文ヘッダーID | `/orders/view/:id` |
| `order` | 16文字の注文ヘッダー一意キー | `/orders/view2/:uniqueKey` |
| `shop` | ショップID | `/shops/view2/:shopId` |
| `user` | ショップ利用者ID | `/shops/view/:userId` |

注文の識別子が大文字の16進数16文字に完全一致する場合は、数字だけで構成されていても注文ヘッダー一意キーとして扱う。
一意キーの経路は`/orders/view/:id`へリダイレクトされるため、遷移後も選択した環境のoriginと最終パスを検証する。

対象画面はCakePHPがサーバー側でHTMLを生成しており、主要データを取得するJSON APIはないため、初期実装はレンダリング済みDOMを取得元とする。

複数IDは入力順に1件ずつ取得する。
途中で失敗した場合は対象IDと原因を返し、後続IDを取得しない。

### 接続先の追加順序

PoCは`https://a.baselocal.info`を接続先とする。
PoCでCDP接続の再利用、DOM抽出、認証切れの扱いを確認した後、`prod`、`dev_green`、`stg`の順に接続先を追加する。
各環境のoriginは対応時に確定してコードへ追加し、利用者から任意のoriginを受け取らない。
DOM抽出処理は環境間で共有するが、環境を追加する前に対象画面のDOM構造と認証切れの遷移が既存環境と同じであることを確認する。

### 安全性

- CDP接続はChromeプロファイル全体へアクセスできるため、CLIを信頼するローカルプログラムとして扱う
- ローカルソケットは実行した利用者だけがアクセスできる`700`の専用ディレクトリ内に置き、ソケットは`600`で作成する
- ローカルソケットへ接続するときと残ったソケットを削除するときは、所有者が実行した利用者と一致することを検証する
- バックグラウンドプロセスは列挙した環境、リソース、状態確認だけを受け付け、任意のURLやCDPコマンドを受け取らない
- 接続先のoriginとパスをコードへ列挙し、任意URLを受け取らない
- 画面遷移とリダイレクトのたびにoriginを検証し、選択した環境に対応する固定originと完全一致しない場合は処理を中止する
- ページ全体、Cookie、個人情報をCLIの出力やログへ渡さない
- 更新操作を行わず、読み取り専用の画面だけを開く

### 検討した代替案

| 案 | 採用しない理由 |
| --- | --- |
| 参照用APIを新設する | 新しいネットワーク境界と認可の設計が必要になる |
| 汎用MCPサーバーを公開する | 今回必要な読み取り専用CLIより操作範囲が広がる |
| 各環境のDBを直接参照する | base_adminの認証と表示上の制約を迂回する。DB権限を持たないエンジニアが利用できず、任意クエリを実行できる経路にもなる |
| `--remote-debugging-port`付きでChromeを起動する | Chromeの起動方法と専用プロファイルを利用者へ要求する |

### ビルドと配布

GitHub ActionsからGoReleaserを実行し、タグを付けたバージョンの配布用バイナリを生成する。
リリース手順はワークフローへ固定し、開発者ごとのローカル環境へ依存させない。

### 参考

- <https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect>
- <https://github.com/puppeteer/puppeteer/blob/puppeteer-v25.4.0/packages/puppeteer-core/src/common/BrowserConnector.ts>
- <https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md#how-it-works>
- <https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/browser.ts>
- <https://github.com/chromedp/chromedp>
- <https://goreleaser.com/>
