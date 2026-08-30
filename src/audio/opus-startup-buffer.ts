type OpusStartupBufferLimits = {
  maxPackets: number;
  maxBytes: number;
};

export type OpusStartupPacketMetadata = {
  captureSequence?: number;
};

export type BufferedOpusPacket = {
  packet: Buffer;
  metadata?: OpusStartupPacketMetadata;
};

export class OpusStartupBuffer {
  readonly #limits: OpusStartupBufferLimits;
  #packets: BufferedOpusPacket[] = [];
  #bytes = 0;

  public constructor(limits: OpusStartupBufferLimits) {
    this.#limits = limits;
  }

  public enqueue(packet: Buffer, metadata?: OpusStartupPacketMetadata): boolean {
    if (
      this.#packets.length >= this.#limits.maxPackets ||
      this.#bytes + packet.length > this.#limits.maxBytes
    ) {
      return false;
    }
    const copy = Buffer.from(packet);
    this.#packets.push({
      packet: copy,
      ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
    });
    this.#bytes += copy.length;
    return true;
  }

  public drain(): Buffer[] {
    return this.drainEntries().map((entry) => entry.packet);
  }

  public drainEntries(): BufferedOpusPacket[] {
    const packets = this.#packets;
    this.#packets = [];
    this.#bytes = 0;
    return packets;
  }

  public clear(): void {
    this.#packets = [];
    this.#bytes = 0;
  }
}
