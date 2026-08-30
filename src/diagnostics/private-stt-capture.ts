import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  type WriteStream,
} from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { RealtimeToken } from "@soniox/node";

import type { LanguagePair } from "../domain/language-pair.js";
import type { SttFinalizeReason } from "../audio/stt-turn-finalizer.js";

const captureDirectoryMode = 0o700;
const captureFileMode = 0o600;
const captureFileHighWaterMark = 1024 * 1024;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repositoryPrivateCaptureRoot = path.join(repositoryRoot, ".data", "stt-eval");

type CaptureFailureHandler = (error: Error) => void;

type CaptureEventTime = {
  turnId: string;
  atMonotonicMs: number;
};

export type PrivateSttCaptureSpeaker = {
  speakingStarted(input: CaptureEventTime): void;
  speakingEnded(input: CaptureEventTime): void;
  recordOpusPacket(input: CaptureEventTime & { packet: Buffer }): number;
  recordDecodedPacket(input: {
    packetSequence: number;
    atMonotonicMs: number;
    stereoPcm: Buffer;
    monoPcm: Buffer;
  }): void;
  recordSonioxAudio(input: CaptureEventTime & {
    kind: "decoded_packet";
    packetSequence: number;
    monoPcm: Buffer;
  } | CaptureEventTime & {
    kind: "trailing_silence";
    monoPcm: Buffer;
  }): void;
  recordDroppedPacket(input: {
    packetSequence: number;
    atMonotonicMs: number;
  }): void;
  recordReceiveEvent(input: CaptureEventTime & {
    kind: "receive_stream_closed" | "receive_stream_recovered";
  }): void;
  recordSttBoundary(input: CaptureEventTime & {
    kind: "endpoint" | "finalized";
  }): void;
  recordFinalizeRequested(input: CaptureEventTime & {
    reason: SttFinalizeReason;
  }): void;
  recordSttResult(input: CaptureEventTime & {
    tokens: readonly RealtimeToken[];
  }): void;
};

export type PrivateSttCaptureSession = {
  createSpeaker(): PrivateSttCaptureSpeaker;
  close(): Promise<void>;
};

export type PrivateSttCaptureFactory = {
  createSession(input: {
    pair: LanguagePair;
    startedAtMonotonicMs: number;
    onError?: CaptureFailureHandler;
  }): Promise<PrivateSttCaptureSession>;
};

class CaptureFile {
  readonly #stream: WriteStream;
  readonly #onError: CaptureFailureHandler;
  #failure: Error | undefined;
  #ending = false;

  public constructor(filePath: string, onError: CaptureFailureHandler) {
    this.#onError = onError;
    this.#stream = createWriteStream(filePath, {
      flags: "wx",
      mode: captureFileMode,
      highWaterMark: captureFileHighWaterMark,
    });
    this.#stream.once("error", (error) => this.#fail(error));
  }

  public write(value: string | Buffer): void {
    if (this.#failure || this.#ending) return;
    if (!this.#stream.write(value)) {
      this.#fail(new Error("private STT captureの書き込み待ち上限へ達しました"));
    }
  }

  public async close(): Promise<void> {
    if (!this.#ending) {
      this.#ending = true;
      this.#stream.end();
    }
    try {
      await finished(this.#stream);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error("private STT captureを終了できません"));
    }
    if (this.#failure) throw this.#failure;
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#onError(error);
  }
}

type CaptureFiles = {
  opus: CaptureFile;
  stereo: CaptureFile;
  decodedMono: CaptureFile;
  sonioxInput: CaptureFile;
  events: CaptureFile;
  results: CaptureFile;
};

function eventLine(fields: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(fields)}\n`;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function capturedToken(token: RealtimeToken): Readonly<Record<string, unknown>> {
  return {
    text: token.text,
    is_final: token.is_final,
    ...(token.language === undefined ? {} : { language: token.language }),
    ...(token.source_language === undefined
      ? {}
      : { source_language: token.source_language }),
    confidence: token.confidence,
    ...(token.start_ms === undefined ? {} : { start_ms: token.start_ms }),
    ...(token.end_ms === undefined ? {} : { end_ms: token.end_ms }),
  };
}

class FilePrivateSttCaptureSpeaker implements PrivateSttCaptureSpeaker {
  readonly #files: CaptureFiles;
  readonly #startedAtMonotonicMs: number;
  #packetSequence = 0;
  #opusOffset = 0;
  #stereoOffset = 0;
  #monoOffset = 0;
  #sonioxOffset = 0;

  public constructor(files: CaptureFiles, startedAtMonotonicMs: number) {
    this.#files = files;
    this.#startedAtMonotonicMs = startedAtMonotonicMs;
  }

  public speakingStarted(input: CaptureEventTime): void {
    this.#writeTimedEvent("speaking_start", input);
  }

  public speakingEnded(input: CaptureEventTime): void {
    this.#writeTimedEvent("speaking_end", input);
  }

  public recordOpusPacket(input: CaptureEventTime & { packet: Buffer }): number {
    const packetSequence = this.#packetSequence;
    this.#packetSequence += 1;
    const opusOffset = this.#opusOffset;
    this.#opusOffset += input.packet.length;
    this.#files.opus.write(Buffer.from(input.packet));
    this.#files.events.write(eventLine({
      kind: "opus_packet",
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
      packet_sequence: packetSequence,
      opus_offset: opusOffset,
      opus_byte_length: input.packet.length,
    }));
    return packetSequence;
  }

  public recordDecodedPacket(input: {
    packetSequence: number;
    atMonotonicMs: number;
    stereoPcm: Buffer;
    monoPcm: Buffer;
  }): void {
    const stereoOffset = this.#stereoOffset;
    const monoOffset = this.#monoOffset;
    this.#stereoOffset += input.stereoPcm.length;
    this.#monoOffset += input.monoPcm.length;
    this.#files.stereo.write(input.stereoPcm);
    this.#files.decodedMono.write(input.monoPcm);
    this.#files.events.write(eventLine({
      kind: "decoded_packet",
      packet_sequence: input.packetSequence,
      at_ms: this.#elapsed(input.atMonotonicMs),
      stereo_offset: stereoOffset,
      stereo_byte_length: input.stereoPcm.length,
      mono_offset: monoOffset,
      mono_byte_length: input.monoPcm.length,
    }));
  }

  public recordSonioxAudio(input: CaptureEventTime & {
    kind: "decoded_packet";
    packetSequence: number;
    monoPcm: Buffer;
  } | CaptureEventTime & {
    kind: "trailing_silence";
    monoPcm: Buffer;
  }): void {
    const sonioxOffset = this.#sonioxOffset;
    this.#sonioxOffset += input.monoPcm.length;
    this.#files.sonioxInput.write(input.monoPcm);
    this.#files.events.write(eventLine({
      kind: "soniox_audio_sent",
      audio_kind: input.kind,
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
      ...(input.kind === "decoded_packet"
        ? { packet_sequence: input.packetSequence }
        : {}),
      soniox_offset: sonioxOffset,
      soniox_byte_length: input.monoPcm.length,
    }));
  }

  public recordDroppedPacket(input: {
    packetSequence: number;
    atMonotonicMs: number;
  }): void {
    this.#files.events.write(eventLine({
      kind: "decode_failed",
      packet_sequence: input.packetSequence,
      at_ms: this.#elapsed(input.atMonotonicMs),
    }));
  }

  public recordReceiveEvent(input: CaptureEventTime & {
    kind: "receive_stream_closed" | "receive_stream_recovered";
  }): void {
    this.#writeTimedEvent(input.kind, input);
  }

  public recordSttBoundary(input: CaptureEventTime & {
    kind: "endpoint" | "finalized";
  }): void {
    this.#files.events.write(eventLine({
      kind: "stt_boundary",
      boundary: input.kind,
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
    }));
  }

  public recordFinalizeRequested(input: CaptureEventTime & {
    reason: SttFinalizeReason;
  }): void {
    this.#files.events.write(eventLine({
      kind: "manual_finalize_requested",
      reason: input.reason,
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
    }));
  }

  public recordSttResult(input: CaptureEventTime & {
    tokens: readonly RealtimeToken[];
  }): void {
    const originalTokens: Readonly<Record<string, unknown>>[] = [];
    const translationTokens: Readonly<Record<string, unknown>>[] = [];
    const otherTokens: Readonly<Record<string, unknown>>[] = [];
    for (const token of input.tokens) {
      const captured = capturedToken(token);
      if (token.translation_status === "original") {
        originalTokens.push(captured);
      } else if (token.translation_status === "translation") {
        translationTokens.push(captured);
      } else {
        otherTokens.push({
          ...captured,
          ...(token.translation_status === undefined
            ? {}
            : { translation_status: token.translation_status }),
        });
      }
    }
    this.#files.results.write(eventLine({
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
      original_tokens: originalTokens,
      translation_tokens: translationTokens,
      other_tokens: otherTokens,
    }));
  }

  #writeTimedEvent(kind: string, input: CaptureEventTime): void {
    this.#files.events.write(eventLine({
      kind,
      turn_id: input.turnId,
      at_ms: this.#elapsed(input.atMonotonicMs),
    }));
  }

  #elapsed(atMonotonicMs: number): number {
    return roundMilliseconds(Math.max(0, atMonotonicMs - this.#startedAtMonotonicMs));
  }
}

class FilePrivateSttCaptureSession implements PrivateSttCaptureSession {
  readonly #directoryPath: string;
  readonly #startedAtMonotonicMs: number;
  readonly #onError: CaptureFailureHandler;
  readonly #files: CaptureFile[] = [];
  #speakerCount = 0;
  #closed = false;

  public constructor(
    directoryPath: string,
    startedAtMonotonicMs: number,
    onError: CaptureFailureHandler,
  ) {
    this.#directoryPath = directoryPath;
    this.#startedAtMonotonicMs = startedAtMonotonicMs;
    this.#onError = onError;
  }

  public createSpeaker(): PrivateSttCaptureSpeaker {
    if (this.#closed) throw new Error("終了済みのprivate STT captureへ話者を追加できません");
    this.#speakerCount += 1;
    const prefix = `speaker-${String(this.#speakerCount).padStart(2, "0")}`;
    const files: CaptureFiles = {
      opus: this.#file(`${prefix}-opus.bin`),
      stereo: this.#file(`${prefix}-stereo.pcm`),
      decodedMono: this.#file(`${prefix}-decoded-mono.pcm`),
      sonioxInput: this.#file(`${prefix}-soniox-input.pcm`),
      events: this.#file(`${prefix}-events.jsonl`),
      results: this.#file(`${prefix}-results.jsonl`),
    };
    return new FilePrivateSttCaptureSpeaker(files, this.#startedAtMonotonicMs);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled(this.#files.map(async (file) => await file.close()));
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason as unknown);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "private STT captureを正常に終了できませんでした");
    }
  }

  #file(fileName: string): CaptureFile {
    const file = new CaptureFile(path.join(this.#directoryPath, fileName), this.#onError);
    this.#files.push(file);
    return file;
  }
}

class FilePrivateSttCaptureFactory implements PrivateSttCaptureFactory {
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
  }

  public async createSession(input: {
    pair: LanguagePair;
    startedAtMonotonicMs: number;
    onError?: CaptureFailureHandler;
  }): Promise<PrivateSttCaptureSession> {
    const directoryPath = path.join(this.#rootDirectory, `capture-${randomUUID()}`);
    await mkdir(directoryPath, { mode: captureDirectoryMode });
    await writeFile(
      path.join(directoryPath, "session.json"),
      `${JSON.stringify({
        version: 1,
        pair: input.pair,
        audio_format: "pcm_s16le",
        sample_rate: 48_000,
        decoded_channels: 2,
        soniox_channels: 1,
      })}\n`,
      { flag: "wx", mode: captureFileMode },
    );
    return new FilePrivateSttCaptureSession(
      directoryPath,
      input.startedAtMonotonicMs,
      input.onError ?? (() => undefined),
    );
  }
}

export async function validatePrivateSttCaptureDirectory(
  directoryPath: string,
): Promise<string> {
  if (!path.isAbsolute(directoryPath)) {
    throw new Error("private STT capture directoryは絶対pathで指定してください");
  }
  const requestedPath = path.resolve(directoryPath);
  if (
    isWithinPath(repositoryRoot, requestedPath) &&
    !isWithinPath(repositoryPrivateCaptureRoot, requestedPath)
  ) {
    throw new Error(
      "repository内のprivate STT capture directoryは.data/stt-eval配下にしてください",
    );
  }
  const status = await lstat(requestedPath);
  if (status.isSymbolicLink()) {
    throw new Error("private STT capture directoryにsymbolic linkは指定できません");
  }
  if (!status.isDirectory() || (status.mode & 0o7777) !== captureDirectoryMode) {
    throw new Error("private STT capture directoryは所有者専用の0700にしてください");
  }
  if (await realpath(requestedPath) !== requestedPath) {
    throw new Error("private STT capture directoryの親にsymbolic linkは指定できません");
  }
  return requestedPath;
}

export async function openPrivateSttCaptureFactory(
  directoryPath: string | undefined,
): Promise<PrivateSttCaptureFactory | undefined> {
  if (directoryPath === undefined) return undefined;
  return new FilePrivateSttCaptureFactory(
    await validatePrivateSttCaptureDirectory(directoryPath),
  );
}
