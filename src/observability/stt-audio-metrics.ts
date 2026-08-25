import type { SttAcceptedFinalizeReason } from "../audio/stt-turn-finalizer.js";
import type { OriginalConfidenceSummary } from "../translation/token-assembler.js";

const pcmFullScale = 32_768;
const samplesPerTwentyMilliseconds = 960;
const nearSilenceThresholdDbfs = -60;
const nearSilenceMeanSquareThreshold = (
  pcmFullScale * 10 ** (nearSilenceThresholdDbfs / 20)
) ** 2;

export type SttAudioMetricsLogFields = {
  trace_id: string;
  rms_dbfs: number | null;
  peak_dbfs: number | null;
  clipped_sample_ratio: number | null;
  near_silence_ratio: number | null;
  decoded_packet_count: number;
  dropped_packet_count: number;
  original_token_count: number;
  original_confidence_mean: number | null;
  original_confidence_min: number | null;
  finalize_reason: SttAcceptedFinalizeReason;
};

type TakeSttAudioMetricsInput = {
  traceId: string;
  finalizeReason: SttAcceptedFinalizeReason;
  originalConfidence?: OriginalConfidenceSummary;
};

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function toDbfs(amplitude: number): number | null {
  if (amplitude === 0) return null;
  return round(20 * Math.log10(amplitude / pcmFullScale), 3);
}

export class SttAudioMetricsAccumulator {
  #sampleCount = 0;
  #squareSum = 0;
  #peakAmplitude = 0;
  #clippedSampleCount = 0;
  #frameSampleCount = 0;
  #frameSquareSum = 0;
  #frameCount = 0;
  #nearSilenceFrameCount = 0;
  #decodedPacketCount = 0;
  #droppedPacketCount = 0;

  public recordDecodedPacket(pcm: Buffer): void {
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
      throw new TypeError("PCM s16le packetは偶数byteのBufferで渡してください");
    }
    this.#decodedPacketCount += 1;
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset);
      const amplitude = Math.abs(sample);
      const square = sample * sample;
      this.#sampleCount += 1;
      this.#squareSum += square;
      this.#peakAmplitude = Math.max(this.#peakAmplitude, amplitude);
      if (sample === -32_768 || sample === 32_767) this.#clippedSampleCount += 1;
      this.#frameSampleCount += 1;
      this.#frameSquareSum += square;
      if (this.#frameSampleCount === samplesPerTwentyMilliseconds) {
        this.#completeFrame();
      }
    }
  }

  public recordDroppedPacket(): void {
    this.#droppedPacketCount += 1;
  }

  public take(input: TakeSttAudioMetricsInput): SttAudioMetricsLogFields {
    let frameCount = this.#frameCount;
    let nearSilenceFrameCount = this.#nearSilenceFrameCount;
    if (this.#frameSampleCount > 0) {
      frameCount += 1;
      if (
        this.#frameSquareSum / this.#frameSampleCount <= nearSilenceMeanSquareThreshold
      ) {
        nearSilenceFrameCount += 1;
      }
    }
    const rmsAmplitude = this.#sampleCount === 0
      ? 0
      : Math.sqrt(this.#squareSum / this.#sampleCount);
    const observation: SttAudioMetricsLogFields = {
      trace_id: input.traceId,
      rms_dbfs: toDbfs(rmsAmplitude),
      peak_dbfs: toDbfs(this.#peakAmplitude),
      clipped_sample_ratio: this.#sampleCount === 0
        ? null
        : round(this.#clippedSampleCount / this.#sampleCount, 6),
      near_silence_ratio: frameCount === 0
        ? null
        : round(nearSilenceFrameCount / frameCount, 6),
      decoded_packet_count: this.#decodedPacketCount,
      dropped_packet_count: this.#droppedPacketCount,
      original_token_count: input.originalConfidence?.tokenCount ?? 0,
      original_confidence_mean: input.originalConfidence?.mean ?? null,
      original_confidence_min: input.originalConfidence?.min ?? null,
      finalize_reason: input.finalizeReason,
    };
    this.#reset();
    return observation;
  }

  #completeFrame(): void {
    this.#frameCount += 1;
    if (
      this.#frameSquareSum / this.#frameSampleCount <= nearSilenceMeanSquareThreshold
    ) {
      this.#nearSilenceFrameCount += 1;
    }
    this.#frameSampleCount = 0;
    this.#frameSquareSum = 0;
  }

  #reset(): void {
    this.#sampleCount = 0;
    this.#squareSum = 0;
    this.#peakAmplitude = 0;
    this.#clippedSampleCount = 0;
    this.#frameSampleCount = 0;
    this.#frameSquareSum = 0;
    this.#frameCount = 0;
    this.#nearSilenceFrameCount = 0;
    this.#decodedPacketCount = 0;
    this.#droppedPacketCount = 0;
  }
}
