# Raspberry Piでの補助音声認識の高速化

2026年9月16日の検証記録です。**実験用のMoonshineを高速化できましたが、本番のBotには未導入です。** このPRをマージしても、通話中の認識経路は変わりません。

同じモデルと保存音声で比較したところ、CPUの待機処理を抑える設定により、補助認識の中央値が **1.169秒から1.060秒**になりました。Sonioxの最終訳まで含む再生テストでは、改善後の3回は **2.019〜2.239秒**でした。原文中の対象語と対応する訳語は3回とも正しく認識できています。

## 何を変えたか

![Moonshineの自動認識結果をヒントにしてSonioxが元音声を再認識する検証経路。高速化したのはPi上のMoonshineで、本番には未導入。](../diagrams/stt-refinement-experiment.svg)

[図をHTMLで開く](../diagrams/stt-refinement-experiment.html)

検証では、Pi上のMoonshineで音声を文字起こしし、その自動結果をSonioxの `context.text` に渡しました。Sonioxには元の音声も渡し、再認識と翻訳を行わせています。人が確認した正解文は採点にだけ使い、認識の入力には使っていません。音声モデルの学習や追加学習は行っていません。

高速化したのは、このうちMoonshineの計算です。

| 変更 | 内容と狙い | 確認結果 |
| --- | --- | --- |
| 重みの前処理を再利用 | `session.disable_prepacking=0`。計算に使う重みを実行向けに準備して再利用する | 以前の同条件比較で、補助認識を約1.51秒から約1.09秒へ短縮 |
| 待機中のCPU処理を抑制 | `session.intra_op.allow_spinning=0` と `session.inter_op.allow_spinning=0`。仕事を待つスレッドがCPUを使い続ける動作を止める | 今回の比較で、補助認識をさらに約9%、CPU使用時間を約25%削減 |
| 音声末尾を最後まで処理 | Moonshineを終了する前に160msの無音を追加する | 2.32秒の元音声を全て処理。高速化のために音声を削っていない |

以前の約1.09秒は末尾への無音追加前の値です。今回の速度比較は、改善前後とも同じ160msの無音を追加しています。両者を同じ条件の比較として扱わないでください。

Moonshineは音声の特徴抽出、エンコード、デコードなどに別々のONNX Runtimeセッションを使います。同じ設定オブジェクトを使っていても、Linuxでは各セッションが別の作業スレッド群を持ちます。待機処理を抑える設定でCPU使用時間が減ったことは確認できましたが、各スレッドの競合そのものをトレースしたわけではありません。

末尾の対策は、今回導入を検討しているMoonshine側の処理に対するものです。既存の本番Botが同じ理由で音声を欠落させていたという証拠ではありません。

## 実測値

数値の正本は [measurements.json](measurements.json) です。各条件を連続して3回測りました。実行順をランダムにした比較ではありません。

### 補助認識だけの比較

同一の2.32秒の音声に160msの無音を加え、同じモデルの読み込み後に3回処理しました。モデル読み込み時間は含みません。`prepack` が今回の比較基準です。

| 条件 | 処理時間の中央値 | CPU使用時間の中央値 | プロセスの最大RSS | 文字起こし |
| --- | ---: | ---: | ---: | --- |
| 重みの前処理を再利用 (`prepack`) | 1.169秒 | 4.291秒 | 355.9MiB | 基準 |
| 待機処理を無効化 (`thread-nospin`) | **1.060秒** | **3.220秒** | 356.6MiB | 3回とも基準と全文一致 |
| 計算呼び出し終了時だけ待機処理を止める (`thread-stopspin`) | 1.084秒 | 3.840秒 | 359.1MiB | 3回とも基準と全文一致 |

CPU使用時間は全スレッドの合計なので、実際の待ち時間より大きくなります。最大RSSはPythonとモデルを含む単独プロセスの値で、Bot全体の使用量や同時通話時の追加メモリではありません。今回は処理時間とCPU使用時間の両方が小さかった `thread-nospin` を、次の比較に使いました。

### 音声終了からSonioxの最終訳まで

音声を20msずつ実時間に合わせて再生し、Moonshineの最終認識結果を受け取ってから、同じ音声をSonioxへ送りました。Moonshineの途中結果を採用する方法は、この比較には含みません。

| 条件 | 1回目 | 2回目 | 3回目 | 中央値 | 原文中の対象語・訳語 |
| --- | ---: | ---: | ---: | ---: | --- |
| `prepack` | 2.575秒 | 2.924秒 | 2.265秒 | 2.575秒 | 3回とも正解 |
| `thread-nospin` | **2.174秒** | **2.239秒** | **2.019秒** | **2.174秒** | 3回とも正解 |

改善後の内訳は、音声終了から再認識要求の送信までが0.779〜0.957秒、要求送信から最終訳までが1.240〜1.282秒でした。通信とSoniox側の処理時間にも変動があるため、全体の短縮量を全てローカル設定の効果とは断定しません。

以前報告した約2.39秒は、この追加設定を使う前の1回の測定でした。今回の3回はその値を下回りましたが、通話中の遅延上限を保証する結果ではありません。

## 検証条件と変更の再確認

- Raspberry Pi 4 Model B rev 1.5、RAM約3.7GiB。推論はARM64の隔離コンテナで実行。
- Moonshine Voice `0.1.5`、Japanese Small Streaming、モデル版 `quantized_26_08_23`、ONNX Runtime `1.23.2`。
- 音声は48kHz、16bit、モノラル。改善前後で元のPCMの一致をハッシュで確認。
- Moonshineの更新間隔はPython側・ネイティブ側とも0.5秒。`decode_incomplete_lines=false`。話者識別・単語時刻推定は使わない。
- Sonioxは `stt-rt-v5`、日本リージョン、日本語・韓国語の翻訳。同じ元音声と200msの無音を送り、終了を要求。
- モデルの読み込みは再生開始前。WebSocketの接続開始は元音声の終了時。実際のDiscordのパケット到着間隔、字幕送信、読み上げは測定に含まない。
- 新規の通話録音は行わず、本番の録音設定も変更していない。音声、文字起こし本文、認証情報はこの記録に含めない。

[ort-cpu-options.patch](ort-cpu-options.patch) は、測定で使用した3つの設定変更をMoonshine本体への差分として保存したものです。対象は次のコミットです。

```text
https://github.com/moonshine-ai/moonshine
234f60faa0eb388b01cdf7e60aca232af37aefda (v0.1.5)
core/ort-utils/ort-utils.cpp
```

対象ソースへの適用可否は次のように確認できます。`MOONSHINE_CHECKOUT` は、上記コミットのローカルチェックアウトを指すものとします。

```sh
git -C "$MOONSHINE_CHECKOUT" rev-parse HEAD
git -C "$MOONSHINE_CHECKOUT" apply --check \
  "$PWD/docs/stt-optimization/ort-cpu-options.patch"
```

実機測定では、本体を再ビルドする前の比較用に、同じ設定関数を `LD_PRELOAD` で一時的に差し替えました。このパッチで再ビルドしたライブラリや、Botへ組み込んだ実装の動作確認は未実施です。`LD_PRELOAD` の検証手法をそのまま本番構成には採用していません。

## 残っている課題

- 今回の速度比較は、正解を確認できた日本語の短い発話1つに限る。自然な会話全体の精度向上を示すものではない。
- 正解語を登録しない補助認識で改善した例はあるが、報告された他の誤認識は残っている。
- Moonshine単体に置き換えると、既存の日本語対照音声で誤りが増えた。Sonioxと組み合わせた経路について、日本語・韓国語の対照音声で悪化しないか確認する必要がある。
- 連続発話、同時話者、実際のDiscord受信、字幕・音声出力を含めた遅延とメモリを測る必要がある。

本番には発話途中の短い無音で確定しないための [PR #27](https://github.com/sota411/discord-translate/pull/27) が反映されています。この記録のMoonshineによる補助認識と、その高速化は実験段階です。

## 一次資料

- [Moonshineのセッション生成](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/moonshine-streaming-model.cpp#L192)：同一環境・設定から複数の計算セッションを作る。
- [MoonshineのORT設定](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/ort-utils/ort-utils.cpp#L82)：Linuxの環境生成と、変更前の前処理設定。
- [ONNX Runtime 1.23.2の設定キー](https://github.com/microsoft/onnxruntime/blob/v1.23.2/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h)：`disable_prepacking`、`allow_spinning`、`force_spinning_stop` の仕様。
- [ONNX Runtimeのスレッド管理](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)：セッションごとのスレッドと待機処理の説明。
- [Sonioxのコンテキスト入力](https://soniox.com/docs/stt/concepts/context)：自動認識結果を渡す `context.text` の用途。
