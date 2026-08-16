import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import opus from "@discordjs/opus";

import {
  MonoToStereoTransform,
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

class RecordingTts implements TtsGateway {
  public readonly started: string[] = [];

  public synthesize(input: { text: string }): Promise<SynthesizedSpeech> {
    this.started.push(input.text);
    return Promise.resolve({
      audio: Readable.from([Buffer.from([1, 0, 2, 0])]),
      completed: Promise.resolve(),
      cancel: () => undefined,
    });
  }
}

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

void test("endpoint確定後の再生待ちが上限を超えた発話は再生しない", async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  let now = 0;
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
    maxQueueWaitMs: 5,
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
    "not_played",
  ]);
  assert.equal(failures[0]?.code, "PLAYBACK_BACKLOG");
});

void test("先行再生が終わらなくても再生待ち上限の時点で後続発話を破棄する", {
  timeout: 500,
}, async () => {
  const captions = new RecordingCaptions();
  const playback = new BlockingPlayback();
  const failures: ApplicationError[] = [];
  const processor = new UtteranceProcessor({
    captions,
    tts: new RecordingTts(),
    playback,
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
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: index === 0 ? "一つ目" : "二つ目",
      translatedText,
      sourceDurationMs: 500,
    });
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(playback.releases.length, 1);
  assert.equal(captions.records[1]?.state, "not_played");
  assert.equal(failures[0]?.code, "PLAYBACK_BACKLOG");

  playback.releases.shift()?.();
  await processor.whenIdle();
  assert.equal(failures.length, 1);
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
