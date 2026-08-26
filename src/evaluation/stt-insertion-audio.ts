import { createHash } from "node:crypto";

import opus from "@discordjs/opus";

import { decodeDiscordOpusPacketToMono } from "../audio/pcm.js";

const { OpusEncoder } = opus;
export const sttInsertionPcmSampleRate = 48_000;
export const sttInsertionPcmBytesPerSample = 2;
const validOpusFrameSampleCounts = [120, 240, 480, 960, 1_920, 2_880] as const;

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function monoToStereo(mono: Buffer): Buffer {
  if (mono.length === 0 || mono.length % sttInsertionPcmBytesPerSample !== 0) {
    throw new Error("Opus往復へ渡すmono PCMは正の2バイト境界にしてください");
  }
  const stereo = Buffer.allocUnsafe(mono.length * 2);
  for (
    let sourceOffset = 0, targetOffset = 0;
    sourceOffset < mono.length;
    sourceOffset += 2, targetOffset += 4
  ) {
    const sample = mono.readInt16LE(sourceOffset);
    stereo.writeInt16LE(sample, targetOffset);
    stereo.writeInt16LE(sample, targetOffset + 2);
  }
  return stereo;
}

export class SttInsertionDiscordOpusRoundTrip {
  readonly #codec = new OpusEncoder(sttInsertionPcmSampleRate, 2);

  public process(source: Buffer): { audio: Buffer; paddingSampleCount: number } {
    const sourceSampleCount = source.length / sttInsertionPcmBytesPerSample;
    const frameSampleCount = validOpusFrameSampleCounts.find(
      (candidate) => candidate >= sourceSampleCount,
    );
    if (!frameSampleCount) {
      throw new Error(
        `1 packetのPCM sample数${String(sourceSampleCount)}がOpusの60ms上限を超えています`,
      );
    }
    const padded = Buffer.alloc(frameSampleCount * sttInsertionPcmBytesPerSample);
    source.copy(padded);
    const encoded = this.#codec.encode(monoToStereo(padded));
    const decoded = decodeDiscordOpusPacketToMono(this.#codec, encoded);
    if (!decoded) throw new Error("評価用に生成したOpus packetを復号できませんでした");
    if (decoded.length !== padded.length) {
      throw new Error("Opus往復後のPCM sample数が送信frameと一致しません");
    }
    return {
      audio: decoded,
      paddingSampleCount: frameSampleCount - sourceSampleCount,
    };
  }
}

export function createPcmS16leMonoWav(pcm: Buffer): Buffer {
  if (pcm.length === 0 || pcm.length % sttInsertionPcmBytesPerSample !== 0) {
    throw new Error("WAVへ格納するPCMは正の2バイト境界にしてください");
  }
  if (pcm.length > 0xffff_ffff - 36) {
    throw new Error("WAVへ格納するPCMが4 GiB制限を超えています");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sttInsertionPcmSampleRate, 24);
  header.writeUInt32LE(
    sttInsertionPcmSampleRate * sttInsertionPcmBytesPerSample,
    28,
  );
  header.writeUInt16LE(sttInsertionPcmBytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
