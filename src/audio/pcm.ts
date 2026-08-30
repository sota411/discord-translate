import { Transform, type TransformCallback } from "node:stream";

export const pcmSampleRate = 48_000;

type OpusPacketDecoder = {
  decode(packet: Buffer): Buffer;
};

export type DecodedDiscordOpusPacket = {
  stereoPcm: Buffer;
  monoPcm: Buffer;
};

function decodeDiscordOpusStereo(
  decoder: OpusPacketDecoder,
  packet: Buffer,
): Buffer | undefined {
  if (!Buffer.isBuffer(packet)) {
    throw new TypeError("Discord Opus packetはBufferで渡してください");
  }
  let stereo: Buffer;
  try {
    stereo = decoder.decode(packet);
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "The compressed data passed is corrupted"
    ) {
      return undefined;
    }
    throw error;
  }
  return stereo;
}

export function decodeDiscordOpusPacket(
  decoder: OpusPacketDecoder,
  packet: Buffer,
): DecodedDiscordOpusPacket | undefined {
  const stereoPcm = decodeDiscordOpusStereo(decoder, packet);
  if (!stereoPcm) return undefined;
  return {
    stereoPcm,
    monoPcm: downmixStereoS16leToMono(stereoPcm),
  };
}

export function decodeDiscordOpusPacketToMono(
  decoder: OpusPacketDecoder,
  packet: Buffer,
): Buffer | undefined {
  const stereoPcm = decodeDiscordOpusStereo(decoder, packet);
  return stereoPcm === undefined ? undefined : downmixStereoS16leToMono(stereoPcm);
}

export function downmixStereoS16leToMono(stereo: Buffer): Buffer {
  if (stereo.length % 4 !== 0) {
    throw new Error("stereo PCM s16leの長さが4バイト境界ではありません");
  }
  const mono = Buffer.allocUnsafe(stereo.length / 2);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < stereo.length; sourceOffset += 4, targetOffset += 2) {
    const left = stereo.readInt16LE(sourceOffset);
    const right = stereo.readInt16LE(sourceOffset + 2);
    mono.writeInt16LE(Math.trunc((left + right) / 2), targetOffset);
  }
  return mono;
}

export class MonoToStereoTransform extends Transform {
  #remainder: Buffer | undefined;

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (!Buffer.isBuffer(chunk)) {
      callback(new TypeError("mono PCMはBufferで渡してください"));
      return;
    }
    const input = this.#remainder ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const completeLength = input.length - (input.length % 2);
    this.#remainder = completeLength < input.length
      ? Buffer.from(input.subarray(completeLength))
      : undefined;

    const stereo = Buffer.allocUnsafe(completeLength * 2);
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset < completeLength; sourceOffset += 2, targetOffset += 4) {
      const sample = input.readInt16LE(sourceOffset);
      stereo.writeInt16LE(sample, targetOffset);
      stereo.writeInt16LE(sample, targetOffset + 2);
    }
    if (stereo.length > 0) this.push(stereo);
    callback();
  }

  public override _flush(callback: TransformCallback): void {
    if (this.#remainder) {
      callback(new Error("mono PCM s16leが奇数バイトで終了しました"));
      return;
    }
    callback();
  }
}
