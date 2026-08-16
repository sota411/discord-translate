type OpusStartupBufferLimits = {
  maxPackets: number;
  maxBytes: number;
};

export class OpusStartupBuffer {
  readonly #limits: OpusStartupBufferLimits;
  #packets: Buffer[] = [];
  #bytes = 0;

  public constructor(limits: OpusStartupBufferLimits) {
    this.#limits = limits;
  }

  public enqueue(packet: Buffer): boolean {
    if (
      this.#packets.length >= this.#limits.maxPackets ||
      this.#bytes + packet.length > this.#limits.maxBytes
    ) {
      return false;
    }
    const copy = Buffer.from(packet);
    this.#packets.push(copy);
    this.#bytes += copy.length;
    return true;
  }

  public drain(): Buffer[] {
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
