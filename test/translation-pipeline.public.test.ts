import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  MonoToStereoTransform,
  downmixStereoS16leToMono,
} from "../src/audio/pcm.js";
import { ApplicationError } from "../src/domain/application-error.js";
import { TranslationTokenAssembler } from "../src/translation/token-assembler.js";
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

  public async play(audio: Readable, traceId?: string): Promise<void> {
    if (traceId) this.traceIds.push(traceId);
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

  public async play(audio: Readable): Promise<void> {
    this.started += 1;
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

void test("3発話を1件だけ先読みし、再生開始順をendpoint受付順のFIFOに保つ", async () => {
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
    utteranceId: "u-prefetch-1",
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
    utteranceId: "u-prefetch-2",
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
    utteranceId: "u-prefetch-3",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "三つ目",
    translatedText: "세 번째",
    sourceDurationMs: 500,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째", "두 번째"]);
  assert.deepEqual(playback.traceIds, ["u-prefetch-1"]);
  assert.equal(playback.releases.length, 1);

  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.started, ["첫 번째", "두 번째", "세 번째"]);
  assert.deepEqual(playback.traceIds, ["u-prefetch-1", "u-prefetch-2"]);
  assert.equal(playback.releases.length, 1);
  playback.releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(playback.traceIds, [
    "u-prefetch-1",
    "u-prefetch-2",
    "u-prefetch-3",
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

void test("再生中に後から到着した発話も直ちに1件先読みする", async () => {
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
    utteranceId: "u-late-prefetch-1",
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
    utteranceId: "u-late-prefetch-2",
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

void test("先読み中の後続TTSが失敗しても、再生中の先行発話を中断しない", async () => {
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
    utteranceId: "u-prefetch-failure-1",
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
    utteranceId: "u-prefetch-failure-2",
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

void test("先読み後の再生待ちが上限を超えた発話は再生しない", async () => {
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
