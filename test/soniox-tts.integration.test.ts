import assert from "node:assert/strict";
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
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000100",
      now: () => new Date("2026-08-15T03:00:00Z"),
    });

    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000101",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
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

void test("max_audio_duration_reachedを安定したエラーコードへ変換する", async () => {
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
        socket.send(JSON.stringify({ stream_id: message.stream_id, terminated: true }));
      }
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000110",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000111",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      language: "ko",
      text: "긴 문장",
    });

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
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000115",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000116",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
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

void test("cancelはTTS接続を直ちに閉じて要求をfailedへ確定する", async () => {
  const received: Record<string, unknown>[] = [];
  await withServer((socket) => {
    socket.on("message", (data) => {
      received.push(JSON.parse(rawDataToUtf8(data)) as Record<string, unknown>);
    });
  }, async (url) => {
    const ledger = new RecordingLedger();
    const gateway = new RawSonioxTtsGateway({
      url,
      apiKey: "test-api-key",
      model: "tts-rt-v2",
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000120",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000121",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
      language: "ko",
      text: "취소",
    });

    speech.cancel();
    await speech.completed;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    assert.equal(ledger.requests[0]?.status, "failed");
    assert.ok(received.some((message) => message.cancel === true));
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
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000125",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000126",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
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
      voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
      terminationTimeoutMs: 1_000,
      ledger,
      createRequestRef: () => "00000000-0000-4000-8000-000000000130",
    });
    const speech = await gateway.synthesize({
      utteranceId: "00000000-0000-4000-8000-000000000131",
      sessionId: "00000000-0000-4000-8000-000000000001",
      speakerUserId: "323456789012345678",
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
    voices: { ja: "ja-voice", ko: "ko-voice", en: "en-voice" },
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
