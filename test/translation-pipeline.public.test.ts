import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import opus from "@discordjs/opus";

import {
  MonoToStereoTransform,
  decodeDiscordOpusPacket,
  decodeDiscordOpusPacketToMono,
  downmixStereoS16leToMono,
} from "../src/audio/pcm.js";
import { ApplicationError } from "../src/domain/application-error.js";
import type { Language, LanguagePair } from "../src/domain/language-pair.js";
import type { TranslationLatencyRecorder } from "../src/observability/translation-latency.js";
import { TranslationTokenAssembler } from "../src/translation/token-assembler.js";
import { StreamingUtterance } from "../src/translation/streaming-utterance.js";
import {
  UtteranceProcessor,
  type CaptionGateway,
  type CaptionState,
  type PlaybackGateway,
  type SynthesizedSpeech,
  type TtsGateway,
  type TranslationUtterance,
} from "../src/translation/utterance-processor.js";

void test("確定した正しい方向の翻訳だけをendpointで1発話にする", () => {
  const assembler = new TranslationTokenAssembler("ja-ko", {
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });
  assembler.accept({
    text: "こん",
    is_final: false,
    language: "ja",
    translation_status: "original",
  });
  assembler.accept({
    text: "こんにちは",
    is_final: true,
    language: "ja",
    translation_status: "original",
    start_ms: 100,
    end_ms: 900,
  });
  assembler.accept({
    text: "안녕",
    is_final: false,
    language: "ko",
    source_language: "ja",
    translation_status: "translation",
  });
  assembler.accept({
    text: "안녕하세요",
    is_final: true,
    language: "ko",
    source_language: "ja",
    translation_status: "translation",
  });
  assembler.accept({
    text: "ignore",
    is_final: true,
    language: "en",
    source_language: "ja",
    translation_status: "translation",
  });

  assert.deepEqual(assembler.flush(), {
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "こんにちは",
    translatedText: "안녕하세요",
    sourceDurationMs: 800,
  });
  assert.equal(assembler.flush(), undefined);
});

void test("3言語ペアの両方向で確定原文と確定翻訳を組み立てる", () => {
  const pairs: readonly [LanguagePair, Language, string, Language, string][] = [
    ["ja-ko", "ja", "こんにちは", "ko", "안녕하세요"],
    ["ja-en", "ja", "こんにちは", "en", "Hello"],
    ["ko-en", "ko", "안녕하세요", "en", "Hello"],
  ];

  for (const [pair, languageA, textA, languageB, textB] of pairs) {
    for (const [sourceLanguage, originalText, targetLanguage, translatedText] of [
      [languageA, textA, languageB, textB],
      [languageB, textB, languageA, textA],
    ] as const) {
      const assembler = new TranslationTokenAssembler(pair, {
        maxSourceDurationMs: 30_000,
        maxInputCharacters: 300,
      });
      assembler.accept({
        text: originalText,
        is_final: true,
        language: sourceLanguage,
        translation_status: "original",
        start_ms: 0,
        end_ms: 500,
      });
      assembler.accept({
        text: translatedText,
        is_final: true,
        language: targetLanguage,
        source_language: sourceLanguage,
        translation_status: "translation",
      });

      assert.deepEqual(assembler.flush(), {
        sourceLanguage,
        targetLanguage,
        originalText,
        translatedText,
        sourceDurationMs: 500,
      });
    }
  }
});

void test("確定原文の言語判定が揺れてもendpointまでは発話を確定しない", () => {
  const streaming = new StreamingUtterance({
    pair: "ja-ko",
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });

  streaming.accept([{
    text: "こんにちは",
    is_final: true,
    language: "en",
    translation_status: "original",
    start_ms: 0,
    end_ms: 500,
  }]);

  streaming.accept([{
    text: "안녕하세요",
    is_final: true,
    language: "ko",
    source_language: "ja",
    translation_status: "translation",
  }]);
  const endpoint = streaming.takeAtEndpoint();
  assert.deepEqual(endpoint, {
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "こんにちは",
    translatedText: "안녕하세요",
    sourceDurationMs: 500,
  });
});

void test("途中トークンは表示用previewだけを置き換え、確定発話には混ぜない", () => {
  const streaming = new StreamingUtterance({
    pair: "ja-ko",
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });

  const firstPreview = streaming.accept([
    {
      text: "明日の",
      is_final: true,
      language: "ja",
      translation_status: "original",
      start_ms: 0,
      end_ms: 300,
    },
    {
      text: "夜って空い…",
      is_final: false,
      language: "ja",
      translation_status: "original",
    },
    {
      text: "내일 저녁에…",
      is_final: false,
      language: "ko",
      source_language: "ja",
      translation_status: "translation",
    },
  ]);
  assert.deepEqual(firstPreview, {
    originalText: "明日の夜って空い…",
    translatedText: "내일 저녁에…",
  });

  const refinedPreview = streaming.accept([
    {
      text: "夜は空いてる？",
      is_final: false,
      language: "ja",
      translation_status: "original",
    },
    {
      text: "내일 저녁 시간 돼?",
      is_final: false,
      language: "ko",
      source_language: "ja",
      translation_status: "translation",
    },
  ]);
  assert.deepEqual(refinedPreview, {
    originalText: "明日の夜は空いてる？",
    translatedText: "내일 저녁 시간 돼?",
  });
  assert.equal(streaming.takeAtEndpoint(), undefined);
});

void test("翻訳途中結果を待たず原文だけでも仮字幕を表示する", () => {
  const streaming = new StreamingUtterance({
    pair: "ja-ko",
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });

  const preview = streaming.accept([{
    text: "明日の夜って空い…",
    is_final: false,
    language: "ja",
    translation_status: "original",
  }]);

  assert.deepEqual(preview, {
    originalText: "明日の夜って空い…",
    translatedText: "",
  });
  assert.equal(streaming.takeAtEndpoint(), undefined);
});

void test("方向が反転しても確定原文の言語別文字数を優先して継続する", () => {
  const streaming = new StreamingUtterance({
    pair: "ja-ko",
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });
  streaming.accept([
    {
      text: "こんにちは",
      is_final: true,
      language: "ja",
      translation_status: "original",
      start_ms: 0,
      end_ms: 500,
    },
    {
      text: "これは逆方向へ誤判定された長い翻訳です",
      is_final: true,
      language: "ja",
      source_language: "ko",
      translation_status: "translation",
    },
    {
      text: "안녕",
      is_final: true,
      language: "ko",
      source_language: "ja",
      translation_status: "translation",
    },
  ]);

  assert.deepEqual(streaming.takeAtEndpoint(), {
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "こんにちは",
    translatedText: "안녕",
    sourceDurationMs: 500,
  });
});

void test("確定原文の言語別文字数が同じなら長い翻訳方向を採用する", () => {
  const streaming = new StreamingUtterance({
    pair: "ja-ko",
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
  });
  streaming.accept([
    {
      text: "日",
      is_final: true,
      language: "ja",
      translation_status: "original",
      start_ms: 0,
      end_ms: 250,
    },
    {
      text: "한",
      is_final: true,
      language: "ko",
      translation_status: "original",
      start_ms: 250,
      end_ms: 500,
    },
    {
      text: "短",
      is_final: true,
      language: "ja",
      source_language: "ko",
      translation_status: "translation",
    },
    {
      text: "더 긴 번역",
      is_final: true,
      language: "ko",
      source_language: "ja",
      translation_status: "translation",
    },
  ]);

  assert.deepEqual(streaming.takeAtEndpoint(), {
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "日한",
    translatedText: "더 긴 번역",
    sourceDurationMs: 500,
  });
});

void test("endpointが来なくても確定トークン時点で発話上限を拒否する", () => {
  const durationAssembler = new TranslationTokenAssembler("ja-ko", {
    maxSourceDurationMs: 1_000,
    maxInputCharacters: 3,
  });
  assert.throws(
    () => durationAssembler.accept({
      text: "長い発話",
      is_final: true,
      language: "ja",
      translation_status: "original",
      start_ms: 0,
      end_ms: 1_001,
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UTTERANCE_TOO_LONG",
  );

  const textAssembler = new TranslationTokenAssembler("ja-ko", {
    maxSourceDurationMs: 1_000,
    maxInputCharacters: 3,
  });
  assert.throws(
    () => textAssembler.accept({
      text: "너무 길어요",
      is_final: true,
      language: "ko",
      source_language: "ja",
      translation_status: "translation",
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UTTERANCE_TOO_LONG",
  );
});

void test("Discord stereo PCMをmonoへ平均し、TTS mono PCMをstereoへ複製する", async () => {
  const stereo = Buffer.alloc(8);
  stereo.writeInt16LE(1_000, 0);
  stereo.writeInt16LE(3_000, 2);
  stereo.writeInt16LE(-4_000, 4);
  stereo.writeInt16LE(2_000, 6);
  const mono = downmixStereoS16leToMono(stereo);
  assert.deepEqual([...mono.values()], [0xd0, 0x07, 0x18, 0xfc]);

  const transform = new MonoToStereoTransform();
  const output: Buffer[] = [];
  transform.on("data", (chunk: Buffer) => output.push(chunk));
  transform.write(mono.subarray(0, 1));
  transform.end(mono.subarray(1));
  await new Promise<void>((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
  });
  assert.deepEqual(
    Buffer.concat(output),
    Buffer.from([0xd0, 0x07, 0xd0, 0x07, 0x18, 0xfc, 0x18, 0xfc]),
  );
});

void test("Discord Opusの復号直後stereoとSoniox送信前monoを同時に観測できる", () => {
  const stereo = Buffer.alloc(8);
  stereo.writeInt16LE(3_000, 0);
  stereo.writeInt16LE(1_000, 2);
  stereo.writeInt16LE(-2_000, 4);
  stereo.writeInt16LE(2_000, 6);

  const decoded = decodeDiscordOpusPacket(
    { decode: () => stereo },
    Buffer.from([0x01]),
  );

  assert.ok(decoded);
  assert.deepEqual(decoded.stereoPcm, stereo);
  assert.deepEqual(decoded.monoPcm, Buffer.from([0xd0, 0x07, 0x00, 0x00]));
});

void test("破損したDiscord Opus packetはそのpacketだけを破棄する", () => {
  const { OpusEncoder } = opus;
  const corrupted = decodeDiscordOpusPacketToMono(
    new OpusEncoder(48_000, 2),
    Buffer.from([0xff]),
  );
  assert.equal(corrupted, undefined);

  const decoded = decodeDiscordOpusPacketToMono(
    new OpusEncoder(48_000, 2),
    Buffer.from([0x00]),
  );
  assert.ok(decoded);
  assert.equal(decoded.length, 960);

  assert.throws(
    () => decodeDiscordOpusPacketToMono(
      { decode: () => { throw new TypeError("予期しないdecoder障害"); } },
      Buffer.from([0x00]),
    ),
    /予期しないdecoder障害/,
  );
});

type CaptionRecord = { state: CaptionState; original: string; translated: string };

class RecordingCaptions implements CaptionGateway {
  public readonly records: CaptionRecord[] = [];

  public post(input: {
    originalText: string;
    translatedText: string;
    state: CaptionState;
  }): Promise<number> {
    this.records.push({
      state: input.state,
      original: input.originalText,
      translated: input.translatedText,
    });
    return Promise.resolve(this.records.length - 1);
  }

  public update(reference: number, state: CaptionState): Promise<void> {
    const record = this.records[reference];
    assert.ok(record);
    record.state = state;
    return Promise.resolve();
  }
}

class MissingCaptions implements CaptionGateway {
  public post(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public update(): Promise<void> {
    return Promise.reject(new Error("存在しない字幕を更新してはいけません"));
  }
}

class RecordingTts implements TtsGateway {
  public readonly started: string[] = [];
  public readonly speeds: (number | undefined)[] = [];

  public synthesize(input: { text: string; speed?: number }): Promise<SynthesizedSpeech> {
    this.started.push(input.text);
    this.speeds.push(input.speed);
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: Promise.resolve(),
      cancel: () => undefined,
    });
  }
}

void test("実行中に変えた読み上げ速度を次に生成するTTSリクエストから反映する", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    ttsSpeed: 1.15,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });

  processor.enqueue(queuedUtterance("u-speed-1", "一つ目", "첫 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  processor.setTtsSpeed(1.3);
  processor.enqueue(queuedUtterance("u-speed-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(tts.speeds, [1.15, 1.3]);
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  playback.releases.shift()?.();
  await processor.whenIdle();
});

class SecondSynthesisFailsTts implements TtsGateway {
  #calls = 0;

  public synthesize(): Promise<SynthesizedSpeech> {
    this.#calls += 1;
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: this.#calls === 1
        ? Promise.resolve()
        : Promise.reject(new ApplicationError(
            "SONIOX_STREAM_FAILED",
            "後続発話のTTS生成に失敗しました。",
          )),
      cancel: () => undefined,
    });
  }
}

class BlockingPlayback implements PlaybackGateway {
  public readonly played: number[] = [];
  public readonly traceIds: string[] = [];
  public readonly releases: (() => void)[] = [];
  public stops = 0;

  public async play(
    audio: Readable,
    traceId?: string,
    onStarted?: () => void,
  ): Promise<void> {
    if (traceId) this.traceIds.push(traceId);
    onStarted?.();
    for await (const chunk of audio) {
      this.played.push((chunk as Buffer).length);
    }
    await new Promise<void>((resolve) => this.releases.push(resolve));
  }

  public stop(): void {
    this.stops += 1;
  }
}

class BlockingCaptions extends RecordingCaptions {
  public releasePost: (() => void) | undefined;

  public override async post(input: {
    originalText: string;
    translatedText: string;
    state: CaptionState;
  }): Promise<number> {
    await new Promise<void>((resolve) => {
      this.releasePost = resolve;
    });
    return super.post(input);
  }
}

class BlockingCaptionUpdates extends RecordingCaptions {
  public releaseUpdate: (() => void) | undefined;

  public override async update(reference: number, state: CaptionState): Promise<void> {
    await new Promise<void>((resolve) => {
      this.releaseUpdate = resolve;
    });
    await super.update(reference, state);
  }
}

class FirstPostBlockingCaptions extends RecordingCaptions {
  public releaseFirstPost: (() => void) | undefined;
  #postCount = 0;

  public override async post(input: {
    originalText: string;
    translatedText: string;
    state: CaptionState;
  }): Promise<number> {
    this.#postCount += 1;
    if (this.#postCount === 1) {
      await new Promise<void>((resolve) => {
        this.releaseFirstPost = resolve;
      });
    }
    return super.post(input);
  }
}

class ImmediatelyFailingCaptions extends RecordingCaptions {
  public override post(): Promise<number> {
    return Promise.reject(new Error("Discord字幕POSTに失敗しました。"));
  }
}

class RejectableCaptions extends RecordingCaptions {
  public rejectPost: ((error: Error) => void) | undefined;

  public override post(): Promise<number> {
    return new Promise<number>((_resolve, reject) => {
      this.rejectPost = reject;
    });
  }
}

class CancellableTts implements TtsGateway {
  public canceled = 0;
  public resolveCompletion: (() => void) | undefined;

  public synthesize(): Promise<SynthesizedSpeech> {
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: new Promise<void>((resolve) => {
        this.resolveCompletion = resolve;
      }),
      cancel: () => {
        this.canceled += 1;
        this.resolveCompletion?.();
      },
      hasReceivedAudio: () => true,
    });
  }
}

class DeferredTts implements TtsGateway {
  public releaseSynthesis: (() => void) | undefined;

  public synthesize(): Promise<SynthesizedSpeech> {
    return new Promise<SynthesizedSpeech>((resolve) => {
      this.releaseSynthesis = () => resolve({
        audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
        completed: Promise.resolve(),
        cancel: () => undefined,
      });
    });
  }
}

class SecondCompletionDeferredTts implements TtsGateway {
  public releaseSecond: (() => void) | undefined;
  public canceled = 0;
  #calls = 0;

  public synthesize(): Promise<SynthesizedSpeech> {
    this.#calls += 1;
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: this.#calls === 1
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.releaseSecond = resolve;
          }),
      cancel: () => {
        this.canceled += 1;
        this.releaseSecond?.();
      },
    });
  }
}

class SecondCanceledCompletionPendingTts implements TtsGateway {
  public canceled = 0;
  public rejectSecond: ((error: Error) => void) | undefined;
  #calls = 0;

  public synthesize(): Promise<SynthesizedSpeech> {
    this.#calls += 1;
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: this.#calls === 1
        ? Promise.resolve()
        : new Promise<void>((_resolve, reject) => {
            this.rejectSecond = reject;
          }),
      cancel: () => {
        this.canceled += 1;
      },
    });
  }
}

class HangingSynthesisTts implements TtsGateway {
  public aborted = false;

  public synthesize(
    _input: { text: string },
    signal?: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    return new Promise<SynthesizedSpeech>((_resolve, reject) => {
      const abort = (): void => {
        this.aborted = true;
        reject(new DOMException("TTS synthesis aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class SecondSynthesisHangsTts implements TtsGateway {
  public aborted = false;
  #calls = 0;

  public synthesize(
    _input: { text: string },
    signal?: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    this.#calls += 1;
    if (this.#calls === 1) {
      return Promise.resolve({
        audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
        completed: Promise.resolve(),
        cancel: () => undefined,
      });
    }
    return new Promise<SynthesizedSpeech>((_resolve, reject) => {
      const abort = (): void => {
        this.aborted = true;
        reject(new DOMException("TTS synthesis aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class LedgerFailingCancellableTts implements TtsGateway {
  public rejectCompletion: ((error: Error) => void) | undefined;

  public synthesize(): Promise<SynthesizedSpeech> {
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: new Promise<void>((_resolve, reject) => {
        this.rejectCompletion = reject;
      }),
      cancel: () => {
        this.rejectCompletion?.(new ApplicationError(
          "USAGE_LEDGER_UNAVAILABLE",
          "利用量台帳へ書き込めないため、翻訳を停止します。",
        ));
      },
      hasReceivedAudio: () => true,
    });
  }
}

class StopAwarePlayback implements PlaybackGateway {
  public resolvePlayback: (() => void) | undefined;
  public started = 0;
  public stops = 0;

  public async play(
    audio: Readable,
    _traceId?: string,
    onStarted?: () => void,
  ): Promise<void> {
    this.started += 1;
    onStarted?.();
    for await (const chunk of audio) {
      // Consume the public audio stream before waiting for Discord playback completion.
      void chunk;
    }
    await new Promise<void>((resolve) => {
      this.resolvePlayback = resolve;
    });
  }

  public stop(): void {
    this.stops += 1;
    this.resolvePlayback?.();
  }
}

class RequestedButNotStartedPlayback implements PlaybackGateway {
  public requested = 0;
  public stops = 0;
  public resolvePlayback: (() => void) | undefined;

  public play(): Promise<void> {
    this.requested += 1;
    return new Promise<void>((resolve) => {
      this.resolvePlayback = resolve;
    });
  }

  public stop(): void {
    this.stops += 1;
    this.resolvePlayback?.();
  }
}

class InterruptiblePlayback implements PlaybackGateway {
  public stops = 0;
  public resolvePlayback: (() => void) | undefined;
  public rejectPlayback: ((error: Error) => void) | undefined;

  public play(
    _audio: Readable,
    _traceId?: string,
    onStarted?: () => void,
  ): Promise<void> {
    onStarted?.();
    return new Promise<void>((resolve, reject) => {
      this.resolvePlayback = resolve;
      this.rejectPlayback = reject;
    });
  }

  public stop(): void {
    this.stops += 1;
    this.rejectPlayback?.(new Error("明示的に中断されました"));
  }
}

function queuedUtterance(
  utteranceId: string,
  originalText: string,
  translatedText: string,
): TranslationUtterance {
  return {
    utteranceId,
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText,
    translatedText,
    sourceDurationMs: 500,
  };
}

void test("確定発話をFIFOでTTS・再生し、同じ字幕を再生待ちから再生済みへ更新する", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const failures: Error[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => 1_000,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "一つ目",
    translatedText: "첫 번째",
    sourceDurationMs: 500,
  });
  processor.enqueue({
    utteranceId: "u2",
    sessionId: "s1",
    speakerUserId: "user2",
    speakerDisplayName: "friend",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ko",
    targetLanguage: "ja",
    originalText: "두 번째",
    translatedText: "二つ目",
    sourceDurationMs: 500,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째", "二つ目"]);
  assert.equal(playback.releases.length, 1);
  const firstCaption = captions.records[0];
  assert.ok(firstCaption);
  assert.equal(firstCaption.state, "pending");
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstCaption.state, "played");
  playback.releases.shift()?.();
  await processor.whenIdle();

  const secondCaption = captions.records[1];
  assert.ok(secondCaption);
  assert.equal(secondCaption.state, "played");
  assert.deepEqual(failures, []);
});

void test("字幕投稿を待たずTTSとFIFO再生を開始する", async () => {
  const captions = new BlockingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });

  processor.enqueue({
    utteranceId: "u-parallel",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "並列",
    translatedText: "병렬",
    sourceDurationMs: 500,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["병렬"]);
  assert.deepEqual(playback.played, [4]);
  assert.equal(playback.releases.length, 1);
  assert.equal(captions.records.length, 0);

  playback.releases.shift()?.();
  captions.releasePost?.();
  await processor.whenIdle();
  assert.equal(captions.records[0]?.state, "played");
});

void test("再生開始後に字幕投稿が失敗したら音声とセッションを停止する", async () => {
  const captions = new RejectableCaptions();
  const playback = new StopAwarePlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u-caption-failure",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "字幕失敗",
    translatedText: "자막 실패",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.started, 1);

  captions.rejectPost?.(new Error("Discord字幕POSTに失敗しました。"));
  await processor.whenIdle();

  assert.equal(playback.stops, 1);
  assert.equal(failures[0]?.code, "SONIOX_STREAM_FAILED");
});

void test("再生要求後のPlaying通知前に字幕投稿が失敗しても音声を停止する", async () => {
  const captions = new RejectableCaptions();
  const playback = new RequestedButNotStartedPlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u-caption-failure-before-playing",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "再生要求済み",
    translatedText: "재생 요청 완료",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.requested, 1);

  captions.rejectPost?.(new Error("Discord字幕POSTに失敗しました。"));
  await processor.whenIdle();

  assert.equal(playback.stops, 1);
  assert.equal(failures[0]?.code, "SONIOX_STREAM_FAILED");
});

void test("再生前に字幕投稿の失敗が確定した発話は再生しない", async () => {
  const tts = new DeferredTts();
  const playback = new StopAwarePlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions: new ImmediatelyFailingCaptions(),
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u-caption-failed-before-playback",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "再生しない",
    translatedText: "재생하지 않음",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.started, 0);

  tts.releaseSynthesis?.();
  await processor.whenIdle();

  assert.equal(playback.started, 0);
  assert.equal(failures[0]?.code, "SONIOX_STREAM_FAILED");
});

void test("字幕を送れず音声だけ継続した場合はcaption_postedを記録しない", async () => {
  const playback = new BlockingPlayback();
  const stages: string[] = [];
  const processor = new UtteranceProcessor({
    captions: new MissingCaptions(),
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    latency: {
      start: () => undefined,
      mark: (_traceId, stage) => stages.push(stage),
      finish: () => undefined,
    },
    onFatal: (error) => assert.fail(error.message),
  });
  processor.enqueue(queuedUtterance(
    "u-without-caption",
    "字幕を送れない",
    "자막을 보낼 수 없음",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  playback.releases.shift()?.();
  await processor.whenIdle();

  assert.equal(stages.includes("caption_posted"), false);
});

void test("3件の確定発話は後続1件だけを生成準備し、endpoint受付順で再生する", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const latencyStages: { traceId: string; stage: string }[] = [];
  const latency: TranslationLatencyRecorder = {
    start: () => undefined,
    mark: (traceId, stage) => latencyStages.push({ traceId, stage }),
    finish: () => undefined,
  };
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    latency,
    onFatal: (error) => assert.fail(error.message),
  });

  processor.enqueue({
    utteranceId: "u-queue-1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "一つ目",
    translatedText: "첫 번째",
    sourceDurationMs: 500,
  });
  processor.enqueue({
    utteranceId: "u-queue-2",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "二つ目",
    translatedText: "두 번째",
    sourceDurationMs: 500,
  });
  processor.enqueue({
    utteranceId: "u-queue-3",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "三つ目",
    translatedText: "세 번째",
    sourceDurationMs: 500,
  });

  assert.deepEqual(
    latencyStages.filter(({ stage }) => stage === "queue_enqueued"),
    [
      { traceId: "u-queue-1", stage: "queue_enqueued" },
      { traceId: "u-queue-2", stage: "queue_enqueued" },
      { traceId: "u-queue-3", stage: "queue_enqueued" },
    ],
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째", "두 번째"]);
  assert.deepEqual(playback.traceIds, ["u-queue-1"]);
  assert.equal(playback.releases.length, 1);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째", "두 번째", "세 번째"]);
  assert.deepEqual(playback.traceIds, ["u-queue-1", "u-queue-2"]);
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(playback.traceIds, [
    "u-queue-1",
    "u-queue-2",
    "u-queue-3",
  ]);
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await processor.whenIdle();

  assert.deepEqual(captions.records.map((record) => record.state), [
    "played",
    "played",
    "played",
  ]);
});

void test("再生中にendpointで確定した後続発話は1件だけ生成準備する", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });

  processor.enqueue({
    utteranceId: "u-late-queue-1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "一つ目",
    translatedText: "첫 번째",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째"]);
  assert.equal(playback.releases.length, 1);

  processor.enqueue({
    utteranceId: "u-late-queue-2",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "二つ目",
    translatedText: "두 번째",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(tts.started, ["첫 번째", "두 번째"]);
  assert.equal(playback.releases.length, 1);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.deepEqual(captions.records.map((record) => record.state), ["played", "played"]);
});

void test("前発話の字幕投稿中でも音声再生が終われば次発話を再生する", async () => {
  const captions = new FirstPostBlockingCaptions();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });

  for (const [index, translatedText] of ["첫 번째", "두 번째"].entries()) {
    const utteranceNumber = String(index + 1);
    processor.enqueue({
      utteranceId: `u-caption-gate-${utteranceNumber}`,
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: index === 0 ? "一つ目" : "二つ目",
      translatedText,
      sourceDurationMs: 500,
    });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.releases.length, 1);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.releases.length, 1);

  captions.releaseFirstPost?.();
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.deepEqual(captions.records.map((record) => record.state), ["played", "played"]);
});

void test("endpoint確定後の後続TTS生成が失敗しても、再生中の先行発話を中断しない", async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts: new SecondSynthesisFailsTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u-queue-failure-1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "一つ目",
    translatedText: "첫 번째",
    sourceDurationMs: 500,
  });
  processor.enqueue({
    utteranceId: "u-queue-failure-2",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "二つ目",
    translatedText: "두 번째",
    sourceDurationMs: 500,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopsBeforeFirstPlaybackCompleted = playback.stops;
  playback.releases.shift()?.();
  await processor.whenIdle();

  assert.equal(stopsBeforeFirstPlaybackCompleted, 0);
  assert.deepEqual(captions.records.map((record) => record.state), [
    "played",
    "not_played",
  ]);
  assert.equal(failures[0]?.code, "SONIOX_STREAM_FAILED");
});

void test("会話優先では2.5秒相当を超えた音声だけを省略し、字幕と後続処理を継続する", async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u-backlog-1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "一つ目",
    translatedText: "첫 번째",
    sourceDurationMs: 500,
  });
  processor.enqueue({
    utteranceId: "u-backlog-2",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "二つ目",
    translatedText: "두 번째",
    sourceDurationMs: 500,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secondPlaybackStarted = playback.releases.length > 0;
  playback.releases.shift()?.();
  await processor.whenIdle();

  assert.equal(secondPlaybackStarted, false);
  assert.deepEqual(captions.records.map((record) => record.state), [
    "played",
    "skipped_delay",
  ]);
  assert.deepEqual(failures, []);

  processor.enqueue({
    utteranceId: "u-backlog-3",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "三つ目",
    translatedText: "세 번째",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.equal(captions.records[2]?.state, "played");
});

void test("古い待機音声を省略しても再生中の先行音声を新しい発話が追い越さない", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue(queuedUtterance("u-skip-chain-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-skip-chain-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));

  assert.equal(playback.releases.length, 1);
  processor.enqueue(queuedUtterance("u-skip-chain-3", "三つ目", "세 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await processor.whenIdle();

  assert.deepEqual(captions.records.map((record) => record.state), [
    "played",
    "skipped_delay",
    "played",
  ]);
  assert.deepEqual(failures, []);
});

void test("会話優先の待ち満了後はTTSを取り消し、モード変更でも古い音声を復活させない", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const tts = new SecondCompletionDeferredTts();
  const playback = new BlockingPlayback();
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => assert.fail(error.message),
  });

  processor.enqueue(queuedUtterance("u-mode-race-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-mode-race-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  processor.setPlaybackMode("accuracy");
  tts.releaseSecond?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(playback.releases.length, 1);
  assert.equal(tts.canceled, 1);
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.deepEqual(captions.records.map((record) => record.state), [
    "played",
    "skipped_delay",
  ]);
});

void test("会話優先の省略はTTS終了通知を待たず字幕とキューを進め、遅い台帳エラーだけを致命化する", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const tts = new SecondCanceledCompletionPendingTts();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue(queuedUtterance("u-pending-cancel-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-pending-cancel-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));

  const stateBeforeTermination = captions.records[1]?.state;
  playback.releases.shift()?.();
  const idleBeforeTermination = await Promise.race([
    processor.whenIdle().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);

  tts.rejectSecond?.(new ApplicationError(
    "USAGE_LEDGER_UNAVAILABLE",
    "利用量台帳へ書き込めないため、翻訳を停止します。",
  ));
  await processor.whenIdle();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(tts.canceled, 1);
  assert.equal(stateBeforeTermination, "skipped_delay");
  assert.equal(idleBeforeTermination, true);
  assert.equal(failures[0]?.code, "USAGE_LEDGER_UNAVAILABLE");
});

void test("会話優先で省略したTTSの未確定台帳を停止時に回収する", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const tts = new SecondCanceledCompletionPendingTts();
  const playback = new BlockingPlayback();
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: () => assert.fail("停止中の台帳エラーを通常実行時エラーにしてはいけません"),
  });

  processor.enqueue(queuedUtterance("u-pending-stop-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-pending-stop-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  playback.releases.shift()?.();
  await processor.whenIdle();

  const stopping = processor.stop();
  const stoppedBeforeSettlement = await Promise.race([
    stopping.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  tts.rejectSecond?.(new ApplicationError(
    "USAGE_LEDGER_UNAVAILABLE",
    "利用量台帳へ書き込めないため、翻訳を停止します。",
  ));

  assert.equal(stoppedBeforeSettlement, false);
  await assert.rejects(
    stopping,
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "USAGE_LEDGER_UNAVAILABLE",
  );
});

void test("会話優先の待ち期限は未解決のTTS合成開始も取り消す", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const tts = new SecondSynthesisHangsTts();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    conversationQueueMaxWaitMs: 5,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });
  processor.enqueue(queuedUtterance("u-synthesis-deadline-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-synthesis-deadline-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setTimeout(resolve, 15));

  assert.equal(tts.aborted, true);
  assert.equal(playback.releases.length, 1);
  assert.equal(captions.records[1]?.state, "skipped_delay");
  playback.releases.shift()?.();
  await processor.whenIdle();
});

void test("会話優先の新しい発話は古い翻訳音声だけを中断し、正確さ優先では中断しない", async () => {
  const utterance = {
    utteranceId: "u-interrupt",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja" as const,
    targetLanguage: "ko" as const,
    originalText: "古い発話",
    translatedText: "이전 발화",
    sourceDurationMs: 500,
  };

  const conversationCaptions = new RecordingCaptions();
  const conversationPlayback = new InterruptiblePlayback();
  const conversationFailures: ApplicationError[] = [];
  const conversation = new UtteranceProcessor({
    captions: conversationCaptions,
    tts: new RecordingTts(),
    playback: conversationPlayback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => conversationFailures.push(error),
  });
  conversation.enqueue(utterance);
  await new Promise<void>((resolve) => setImmediate(resolve));
  conversation.interruptForNewSpeech();
  await conversation.whenIdle();

  assert.equal(conversationPlayback.stops, 1);
  assert.equal(
    conversationCaptions.records[0]?.state,
    "interrupted_for_conversation",
  );
  assert.deepEqual(conversationFailures, []);

  const accuracyCaptions = new RecordingCaptions();
  const accuracyPlayback = new InterruptiblePlayback();
  const accuracy = new UtteranceProcessor({
    captions: accuracyCaptions,
    tts: new RecordingTts(),
    playback: accuracyPlayback,
    playbackMode: "accuracy",
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });
  accuracy.enqueue({ ...utterance, utteranceId: "u-accuracy-no-interrupt" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  accuracy.interruptForNewSpeech();
  assert.equal(accuracyPlayback.stops, 0);
  accuracyPlayback.resolvePlayback?.();
  await accuracy.whenIdle();
  assert.equal(accuracyCaptions.records[0]?.state, "played");
});

void test("字幕のみ切替と新発話割り込みはTTS合成開始待ちも取り消して処理を継続する", {
  timeout: 1_000,
}, async () => {
  const cases = [
    {
      expectedState: "captions_only" as const,
      interrupt: (processor: UtteranceProcessor) => processor.setAudioEnabled(false),
    },
    {
      expectedState: "interrupted_for_conversation" as const,
      interrupt: (processor: UtteranceProcessor) => processor.interruptForNewSpeech(),
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const captions = new RecordingCaptions();
    const tts = new HangingSynthesisTts();
    const failures: ApplicationError[] = [];
    const processor = new UtteranceProcessor({
      captions,
      tts,
      playback: new BlockingPlayback(),
      playbackMode: "conversation",
      maxQueueWaitMs: 10_000,
      maxSourceDurationMs: 30_000,
      maxInputCharacters: 300,
      onFatal: (error) => failures.push(error),
    });
    processor.enqueue(queuedUtterance(
      `u-synthesis-interrupt-${String(index)}`,
      "古い発話",
      "이전 발화",
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));
    testCase.interrupt(processor);
    const completed = await Promise.race([
      processor.whenIdle().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    if (!completed) await processor.stop();

    assert.equal(completed, true);
    assert.equal(tts.aborted, true);
    assert.equal(captions.records[0]?.state, testCase.expectedState);
    assert.deepEqual(failures, []);
  }
});

void test("字幕のみへ変更すると待機音声を止め、後続発話はTTSを生成せず字幕だけ残す", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new InterruptiblePlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });
  processor.setAudioEnabled(false);
  processor.enqueue({
    utteranceId: "u-captions-only",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "字幕だけ",
    translatedText: "자막만",
    sourceDurationMs: 500,
  });
  await processor.whenIdle();

  assert.deepEqual(tts.started, []);
  assert.equal(captions.records[0]?.state, "captions_only");
  assert.deepEqual(failures, []);
});

void test("音声を即時省略した発話は字幕POST待ちを音声待ち時間へ含めない", async () => {
  const captions = new BlockingCaptions();
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback: new BlockingPlayback(),
    playbackMode: "conversation",
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => assert.fail(error.message),
  });
  processor.setAudioEnabled(false);
  processor.enqueue(queuedUtterance(
    "u-caption-post-not-audio-wait",
    "字幕だけ",
    "자막만",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 3_000;

  assert.equal(processor.currentQueueWaitMs(), 0);
  captions.releasePost?.();
  await processor.whenIdle();
});

void test("正確さ優先では再生待ちが警告値を超えてもFIFO再生とセッションを継続する", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    playbackMode: "accuracy",
    maxQueueWaitMs: 10,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => failures.push(error),
  });

  for (const [index, translatedText] of ["첫 번째", "두 번째"].entries()) {
    processor.enqueue({
      utteranceId: `u-real-deadline-${String(index + 1)}`,
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: index === 0 ? "一つ目" : "二つ目",
      translatedText,
      sourceDurationMs: 500,
    });
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(playback.releases.length, 1);
  assert.equal(captions.records[1]?.state, "pending");
  assert.equal(processor.currentQueueWaitMs() >= 10, true);
  assert.deepEqual(failures, []);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.deepEqual(captions.records.map((record) => record.state), ["played", "played"]);
  assert.deepEqual(failures, []);
});

void test("正確さ優先の2.5秒超の待ちを再生開始前にカード更新経路へ通知する", async () => {
  const playback = new BlockingPlayback();
  const queueDelays: number[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions: new RecordingCaptions(),
    tts: new RecordingTts(),
    playback,
    playbackMode: "accuracy",
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onQueueDelay: (delayMs: number) => queueDelays.push(delayMs),
    onFatal: (error) => assert.fail(error.message),
  });
  processor.enqueue(queuedUtterance("u-delay-card-1", "一つ目", "첫 번째"));
  processor.enqueue(queuedUtterance("u-delay-card-2", "二つ目", "두 번째"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 3_000;

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queueDelays, [3_000]);
  playback.releases.shift()?.();
  await processor.whenIdle();
});

void test("待機中に会話優先から正確さ優先へ変えても先行音声を追い越さない", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    playbackMode: "conversation",
    conversationQueueMaxWaitMs: 5,
    maxQueueWaitMs: 10,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: (error) => assert.fail(error.message),
  });
  for (const index of [1, 2]) {
    processor.enqueue({
      utteranceId: `u-mode-change-${String(index)}`,
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
      voiceId: "speaker-test-voice",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: `${String(index)}件目`,
      translatedText: `${String(index)}번째`,
      sourceDurationMs: 500,
    });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  processor.setPlaybackMode("accuracy");
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(playback.releases.length, 1);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.deepEqual(captions.records.map((record) => record.state), ["played", "played"]);
});

void test("再生開始済みの発話は会話優先への切替後も期限切れ扱いにしない", async () => {
  const captions = new RecordingCaptions();
  const playback = new InterruptiblePlayback();
  const failures: ApplicationError[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    playbackMode: "accuracy",
    conversationQueueMaxWaitMs: 5,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    now: () => now,
    onFatal: (error) => failures.push(error),
  });
  processor.enqueue(queuedUtterance(
    "u-playing-mode-change",
    "再生中です",
    "재생 중입니다",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 10;
  processor.setPlaybackMode("conversation");
  playback.rejectPlayback?.(new Error("Discord playback failed"));
  await processor.whenIdle();

  assert.equal(failures[0]?.code, "SONIOX_STREAM_FAILED");
  assert.notEqual(captions.records[0]?.state, "skipped_delay");
});

void test("長すぎる発話は字幕・TTSへ渡さず明示的に失敗する", async () => {
  const captions = new RecordingCaptions();
  const tts = new RecordingTts();
  const playback = new BlockingPlayback();
  const failures: Error[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 1_000,
    maxInputCharacters: 3,
    now: () => 1_000,
    onFatal: (error) => failures.push(error),
  });

  processor.enqueue({
    utteranceId: "u1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "長い発話",
    translatedText: "너무 길어요",
    sourceDurationMs: 1_001,
  });
  await processor.whenIdle();

  assert.equal(tts.started.length, 0);
  assert.equal(captions.records.length, 0);
  assert.match(failures[0]?.message ?? "", /UTTERANCE_TOO_LONG/);
});

void test("再生中の停止は字幕を再生済みに戻さず、一部再生後の終了として確定する", async () => {
  const captions = new RecordingCaptions();
  const tts = new CancellableTts();
  const playback = new StopAwarePlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts,
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });

  processor.enqueue({
    utteranceId: "u-stop",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "停止します",
    translatedText: "중지합니다",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const caption = captions.records[0];
  assert.ok(caption);
  assert.equal(caption.state, "pending");

  await processor.stop();
  await processor.whenIdle();

  assert.equal(tts.canceled, 1);
  assert.equal(caption.state, "partial_failure");
});

void test("字幕投稿が未完了でも明示停止は完了を待たない", async () => {
  const captions = new BlockingCaptions();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback: new StopAwarePlayback(),
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });

  processor.enqueue({
    utteranceId: "u-stop-while-caption-pending",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "停止します",
    translatedText: "중지합니다",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      processor.stop(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("字幕POST待ちで停止がタイムアウトしました。")),
          50,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(captions.records.length, 0);

  captions.releasePost?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captions.records[0]?.state, "not_played");
});

void test("字幕のみ発話の字幕POSTが未完了でも明示停止は完了を待たない", async () => {
  const captions = new BlockingCaptions();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback: new StopAwarePlayback(),
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });
  processor.setAudioEnabled(false);
  processor.enqueue(queuedUtterance(
    "u-stop-while-captions-only-post-pending",
    "停止します",
    "중지합니다",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const stopResult = await Promise.race([
    processor.stop().then(() => "stopped" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  captions.releasePost?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopResult, "stopped");
});

void test("字幕の状態編集が未完了でも明示停止は完了を待たない", async () => {
  const captions = new BlockingCaptionUpdates();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback: {
      play(_audio, _traceId, onStarted) {
        onStarted?.();
        return Promise.resolve();
      },
      stop: () => undefined,
    },
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });
  processor.enqueue(queuedUtterance(
    "u-stop-while-caption-update-pending",
    "再生しました",
    "재생했습니다",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(captions.releaseUpdate);

  const stopResult = await Promise.race([
    processor.stop().then(() => "stopped" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  captions.releaseUpdate();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopResult, "stopped");
});

void test("TTS合成開始Promiseが未完了でも明示停止はキャンセルして完了する", {
  timeout: 500,
}, async () => {
  const tts = new HangingSynthesisTts();
  const processor = new UtteranceProcessor({
    captions: new RecordingCaptions(),
    tts,
    playback: new StopAwarePlayback(),
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });

  processor.enqueue({
    utteranceId: "u-stop-while-tts-synthesis-pending",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "停止します",
    translatedText: "중지합니다",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  await processor.stop();
  assert.equal(tts.aborted, true);
});

void test("音声再生完了後に字幕投稿待ちで停止しても再生済みへ更新する", async () => {
  const captions = new BlockingCaptions();
  const playback = new StopAwarePlayback();
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("利用者停止をfatal errorとして扱ってはいけません"),
  });

  processor.enqueue({
    utteranceId: "u-stop-after-playback",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "再生は完了しました",
    translatedText: "재생은 완료되었습니다",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(playback.started, 1);

  playback.resolvePlayback?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await processor.stop();

  captions.releasePost?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captions.records[0]?.state, "played");
});

void test("停止中のTTS利用台帳エラーは正常停止として隠さない", async () => {
  const captions = new RecordingCaptions();
  const processor = new UtteranceProcessor({
    captions,
    tts: new LedgerFailingCancellableTts(),
    playback: new StopAwarePlayback(),
    maxQueueWaitMs: 10_000,
    maxSourceDurationMs: 30_000,
    maxInputCharacters: 300,
    onFatal: () => assert.fail("停止処理の台帳エラーを通常実行時エラーにしてはいけません"),
  });

  processor.enqueue({
    utteranceId: "u-ledger-stop",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "停止します",
    translatedText: "중지합니다",
    sourceDurationMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(
    processor.stop(),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "USAGE_LEDGER_UNAVAILABLE",
  );
  assert.equal(captions.records[0]?.state, "partial_failure");
});
