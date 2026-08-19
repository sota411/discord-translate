import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { ApplicationError } from "../src/domain/application-error.js";
import {
  RawSonioxTtsGateway,
  type TtsUsageLedger,
} from "../src/soniox/raw-tts-gateway.js";

type RecordedRequest = {
  requestRef: string;
  kind: string;
  status?: string;
  audioMs?: number;
  textCharacterCount?: number;
};

class RecordingLedger implements TtsUsageLedger {
  public readonly requests: RecordedRequest[] = [];

  public openProviderRequest(input: {
    requestRef: string;
    kind: "tts";
  }): void {
    this.requests.push({ requestRef: input.requestRef, kind: input.kind });
  }

  public recordProviderUsage(input: {
    requestRef: string;
    audioMs: number;
    textCharacterCount: number;
  }): void {
    const request = this.requests.find((candidate) => candidate.requestRef === input.requestRef);
    assert.ok(request);
    request.audioMs = input.audioMs;
    request.textCharacterCount = input.textCharacterCount;
  }

  public finishProviderRequest(requestRef: string, status: "completed" | "failed"): void {
    const request = this.requests.find((candidate) => candidate.requestRef === requestRef);
    assert.ok(request);
    request.status = status;
  }
}

function rawDataToUtf8(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function withServer(
  onConnection: (socket: WebSocket) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`ws://127.0.0.1:${String(address.port)}`);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

void test("TTS wireへ不透明request refを送り、PCMと正常終端を公開streamへ返す", async () => {
  const received: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      received.push(message);
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      speed: 1.15,
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000100",
      now: () => new Date("2026-08-15T03:00:00Z"),
    });

    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000101",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "안녕하세요",
    });
    const audio: Buffer[] = [];
    for await (const chunk of speech.audio) audio.push(chunk as Buffer);
    await speech.completed;

    assert.deepEqual(Buffer.concat(audio), Buffer.from([1, 0, 2, 0]));
    const config = received[0];
    assert.ok(config);
    assert.equal(config.api_key, "test-api-key");
    assert.equal(config.client_reference_id, "00000000-0000-4000-8000-000000000100");
    assert.equal(config.stream_id, "00000000-0000-4000-8000-000000000101");
    assert.equal(config.reduce_silence, true);
    assert.equal(config.speed, 1.15);
    assert.deepEqual(received[1], {
      stream_id: "00000000-0000-4000-8000-000000000101",
      text: "안녕하세요",
      text_end: true,
    });
    assert.deepEqual(ledger.requests, [{
      requestRef: "00000000-0000-4000-8000-000000000100",
      kind: "tts",
      status: "completed",
      audioMs: 1,
      textCharacterCount: 5,
    }]);
  });
});

void test("翻訳先言語ではなく話者へ割り当てたvoiceをTTS configへ送る", async () => {
  const received: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      received.push(message);
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger: new RecordingLedger(),
      createRequestRef: () => "00000000-0000-4000-8000-000000000150",
    });

    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000151",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "안녕하세요",
    });
    const audio: Buffer[] = [];
    for await (const chunk of speech.audio) audio.push(chunk as Buffer);
    await speech.completed;

    assert.equal(received.length, 2);
    const config = received[0];
    assert.ok(config);
    assert.equal(config.stream_id, "00000000-0000-4000-8000-000000000151");
    assert.equal(config.voice, "speaker-voice");
    assert.deepEqual(Buffer.concat(audio), Buffer.from([1, 0, 2, 0]));
    assert.deepEqual(received[1], {
      stream_id: "00000000-0000-4000-8000-000000000151",
      text: "안녕하세요",
      text_end: true,
    });
    gateway.close();
  });
});

void test("本文を送らない接続ウォームアップ後も連続TTSが同じWebSocketを再利用する", async () => {
  let connectionCount = 0;
  let messageCount = 0;
  let resolveConnected = (): void => undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  await withServer((socket) => {
    connectionCount += 1;
    resolveConnected();
    socket.on("message", (data) => {
      messageCount += 1;
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger: new RecordingLedger(),
    });
    gateway.warm();
    await connected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messageCount, 0);

    for (const utteranceId of ["stream-1", "stream-2"]) {
      const speech = await gateway.synthesize({
        utteranceId,
        sessionId: "session-1",
        speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
        language: "ko",
        text: "연속",
      });
      for await (const chunk of speech.audio) void chunk;
      await speech.completed;
    }

    assert.equal(connectionCount, 1);
  });
});

void test("最初のstream後は同じTTS接続へkeepaliveを送る", async () => {
  let resolveKeepalive = (): void => undefined;
  const keepalive = new Promise<void>((resolve) => {
    resolveKeepalive = resolve;
  });
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      } else if (message.keep_alive === true) {
        resolveKeepalive();
      }
    });
  }, async (url) => {
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      keepaliveIntervalMs: 5,
      ledger: new RecordingLedger(),
    });
    const speech = await gateway.synthesize({
      utteranceId: "keepalive-1",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "연결 유지",
    });
    for await (const chunk of speech.audio) void chunk;
    await speech.completed;
    await keepalive;
    gateway.close();
  });
});

void test("待機中に閉じたTTS接続は次のstream開始時に再接続する", async () => {
  let connectionCount = 0;
  let resolveFirstClosed = (): void => undefined;
  const firstClosed = new Promise<void>((resolve) => {
    resolveFirstClosed = resolve;
  });
  await withServer((socket) => {
    connectionCount += 1;
    const currentConnection = connectionCount;
    socket.on("close", () => {
      if (currentConnection === 1) resolveFirstClosed();
    });
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
          audio_end: true,
        }));
        socket.send(
          JSON.stringify({ stream_id: message.stream_id, terminated: true }),
          () => {
            if (currentConnection === 1) socket.close();
          },
        );
      }
    });
  }, async (url) => {
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger: new RecordingLedger(),
    });

    const first = await gateway.synthesize({
      utteranceId: "reconnect-1",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "첫 번째",
    });
    for await (const chunk of first.audio) void chunk;
    await first.completed;
    await firstClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = await gateway.synthesize({
      utteranceId: "reconnect-2",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "두 번째",
    });
    for await (const chunk of second.audio) void chunk;
    await second.completed;

    assert.equal(connectionCount, 2);
  });
});

void test("stream応答timeoutでは接続を破棄し、次のstreamで再接続する", async () => {
  let connectionCount = 0;
  let resolveFirstClosed = (): void => undefined;
  const firstClosed = new Promise<void>((resolve) => {
    resolveFirstClosed = resolve;
  });
  await withServer((socket) => {
    connectionCount += 1;
    const currentConnection = connectionCount;
    socket.on("close", () => {
      if (currentConnection === 1) resolveFirstClosed();
    });
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true && currentConnection === 2) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 10,
      ledger,
    });

    const timedOut = await gateway.synthesize({
      utteranceId: "timeout-1",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "응답 없음",
    });
    timedOut.audio.resume();
    await assert.rejects(
      timedOut.completed,
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "SONIOX_STREAM_FAILED",
    );
    await firstClosed;

    const recovered = await gateway.synthesize({
      utteranceId: "timeout-2",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "재연결",
    });
    for await (const chunk of recovered.audio) void chunk;
    await recovered.completed;

    assert.equal(connectionCount, 2);
    assert.deepEqual(ledger.requests.map((request) => request.status), [
      "failed",
      "completed",
    ]);
  });
});

void test("max_audio_duration_reachedを安定したエラーコードへ変換する", async () => {
  let terminateFailedStream = (): void => undefined;
  let resolveErrorReceived = (): void => undefined;
  const errorReceived = new Promise<void>((resolve) => {
    resolveErrorReceived = resolve;
  });
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          error_code: 413,
          error_type: "max_audio_duration_reached",
          error_message: "output too long",
        }));
        terminateFailedStream = () => {
          socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
        };
        resolveErrorReceived();
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000110",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000111",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "긴 문장",
    });

    await errorReceived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ledger.requests[0]?.status, undefined);
    terminateFailedStream();

    await assert.rejects(
      speech.completed,
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "TTS_OUTPUT_LIMIT_REACHED",
    );
    assert.equal(ledger.requests[0]?.status, "failed");
  });
});

void test("stream IDのない認証エラーも待機せず安定したエラーコードへ変換する", async () => {
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          error_code: 401,
          error_type: "authentication_error",
          error_message: "invalid key",
        }), () => socket.close());
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "invalid-test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000115",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000116",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "인증 오류",
    });

    await assert.rejects(
      speech.completed,
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "SONIOX_AUTH_FAILED",
    );
    assert.equal(ledger.requests[0]?.status, "failed");
  });
});

void test("cancelはterminatedを受信してから要求をfailedへ確定する", async () => {
  const received: Record<string, unknown>[] = [];
  let terminateCanceledStream = (): void => undefined;
  let resolveCancelReceived = (): void => undefined;
  const cancelReceived = new Promise<void>((resolve) => {
    resolveCancelReceived = resolve;
  });
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      received.push(message);
      if (message.cancel === true) {
        terminateCanceledStream = () => {
          socket.send(JSON.stringify({
            stream_id: message.stream_id,
            terminated: true,
          }));
        };
        resolveCancelReceived();
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000120",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000121",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "취소",
    });

    speech.cancel();
    await cancelReceived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ledger.requests[0]?.status, undefined);

    terminateCanceledStream();
    await speech.completed;

    assert.equal(ledger.requests[0]?.status, "failed");
    assert.ok(received.some((message) => message.cancel === true));
  });
});

void test("AbortSignalの取消もterminated受信前に要求をfailedへ確定しない", async () => {
  let cancelCount = 0;
  let terminateCanceledStream = (): void => undefined;
  let resolveCancelReceived = (): void => undefined;
  const cancelReceived = new Promise<void>((resolve) => {
    resolveCancelReceived = resolve;
  });
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.cancel === true) {
        cancelCount += 1;
        terminateCanceledStream = () => {
          socket.send(JSON.stringify({
            stream_id: message.stream_id,
            terminated: true,
          }));
        };
        resolveCancelReceived();
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000152",
    });
    const controller = new AbortController();
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000153",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "신호로 취소",
    }, controller.signal);
    const completion = speech.completed.then(
      () => undefined,
      () => undefined,
    );

    controller.abort();
    speech.cancel();
    await cancelReceived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelCount, 1);
    assert.equal(ledger.requests[0]?.status, undefined);

    terminateCanceledStream();
    await completion;
    assert.equal(ledger.requests[0]?.status, "failed");
  });
});

void test("音声受信後のcancelで利用台帳へ書き込めなければ失敗を返す", async () => {
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
        }));
      } else if (message.cancel === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          terminated: true,
        }));
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    ledger.recordProviderUsage = () => {
      throw new Error("sqlite write failed");
    };
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000125",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000126",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "취소 중 오류",
    });
    await new Promise<void>((resolve) => speech.audio.once("data", () => resolve()));

    speech.cancel();
    await assert.rejects(
      speech.completed,
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "USAGE_LEDGER_UNAVAILABLE",
    );
  });
});

void test("利用上限エラーでもprovider requestをopenのまま残さない", async () => {
  await withServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
      if (message.text_end === true) {
        socket.send(JSON.stringify({
          stream_id: message.stream_id,
          audio_end: true,
        }));
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    ledger.recordProviderUsage = () => {
      throw new ApplicationError(
        "USAGE_LIMIT_REACHED",
        "globalの月間利用上限へ達しています。",
      );
    };
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000130",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000131",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "한도",
    });

    await assert.rejects(
      speech.completed,
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "USAGE_LIMIT_REACHED",
    );
    assert.equal(ledger.requests[0]?.status, "completed");
  });
});

void test("TTS接続前に失敗した本文は送信済み利用量へ加算しない", async () => {
  const ledger = new RecordingLedger();
  const gateway = new RawSonioxTtsGateway({
    url: "ws://127.0.0.1:1",
    apiKey: "test-api-key",
    model: "tts-rt-v2",
    terminationTimeoutMs: 1_000,
    connectTimeoutMs: 100,
    ledger,
    createRequestRef: () => "00000000-0000-4000-8000-000000000140",
  });

  await assert.rejects(
    gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000141",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "未送信本文",
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "SONIOX_STREAM_FAILED",
  );

  const request = ledger.requests[0];
  assert.ok(request);
  assert.equal(request.status, "failed");
  assert.equal(request.textCharacterCount, 0);
});

const invalidTtsResponses: readonly [
  name: string,
  response: (streamId: unknown) => unknown,
][] = [
  ["null", () => null],
  ["audioが文字列ではない応答", (streamId) => ({ stream_id: streamId, audio: {} })],
  ["audioが不正なbase64の応答", (streamId) => ({ stream_id: streamId, audio: "%%%" })],
];

for (const [name, response] of invalidTtsResponses) {
  void test(`不正なTTS wire応答（${name}）をprocess例外にせずstream失敗へ変換する`, async () => {
    await withServer((socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>;
        if (message.text_end === true) {
          socket.send(JSON.stringify(response(message.stream_id)));
        }
      });
    }, async (url) => {
      const ledger = new RecordingLedger();
      const gateway = new RawSonioxTtsGateway({
        url,
        apiKey: "test-api-key",
        model: "tts-rt-v2",
        terminationTimeoutMs: 1_000,
        ledger,
      });
      const speech = await gateway.synthesize({
        utteranceId: `invalid-wire-${name}`,
        sessionId: "session-1",
        speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
        language: "ko",
        text: "잘못된 응답",
      });
      speech.audio.resume();

      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          assert.rejects(
            speech.completed,
            (error: unknown) =>
              error instanceof ApplicationError && error.code === "SONIOX_STREAM_FAILED",
          ),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("不正応答を即時に拒否しませんでした")),
              200,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      assert.equal(ledger.requests[0]?.status, "failed");
      gateway.close();
    });
  });
}

void test("TTS WebSocket接続待ちでもAbortSignalで合成開始を終了する", {
  timeout: 500,
}, async () => {
  const sockets = new Set<Socket>();
  let resolveConnected = (): void => undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let resolveSocketClosed = (): void => undefined;
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      resolveSocketClosed();
    });
    resolveConnected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ledger = new RecordingLedger();
  const gateway = new RawSonioxTtsGateway({
    url: `ws://127.0.0.1:${String(address.port)}`,
    apiKey: "test-api-key",
    model: "tts-rt-v2",
    terminationTimeoutMs: 10_000,
    connectTimeoutMs: 10_000,
    ledger,
  });

  try {
    const controller = new AbortController();
    const synthesis = gateway.synthesize({
      utteranceId: "abort-while-connecting",
      sessionId: "session-1",
      speakerUserId: "323456789012345678",
      voiceId: "speaker-voice",
      language: "ko",
      text: "연결 중 취소",
    }, controller.signal);
    await connected;
    controller.abort();

    await assert.rejects(
      synthesis,
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "SONIOX_STREAM_FAILED",
    );
    assert.equal(ledger.requests[0]?.status, "failed");
    gateway.close();
    let closeDeadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        socketClosed,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(
            () => reject(new Error("終了時に接続中のTTS socketを閉じませんでした")),
            100,
          );
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }
  } finally {
    gateway.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
