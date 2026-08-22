import { monitorEventLoopDelay, performance } from "node:perf_hooks";

type EventLoopHistogram = {
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
};

type CpuUsage = Pick<NodeJS.CpuUsage, "user" | "system">;
type MemoryUsage = Pick<NodeJS.MemoryUsage, "rss" | "heapUsed">;

export type RuntimeHealthFields = {
  event_loop_p95_ms: number;
  event_loop_max_ms: number;
  process_cpu_pct: number;
  rss_bytes: number;
  heap_used_bytes: number;
  stt_result_count: number;
  stt_result_gap_p95_ms: number | null;
  stt_result_gap_max_ms: number | null;
};

type RuntimeHealthSamplerOptions = {
  eventLoop: EventLoopHistogram;
  now?: () => number;
  cpuUsage?: () => CpuUsage;
  memoryUsage?: () => MemoryUsage;
};

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export class RuntimeHealthSampler {
  readonly #eventLoop: EventLoopHistogram;
  readonly #now: () => number;
  readonly #cpuUsage: () => CpuUsage;
  readonly #memoryUsage: () => MemoryUsage;
  #lastSampleAt: number;
  #lastCpu: CpuUsage;
  #lastSttResultAt: number | undefined;
  #sttResultCount = 0;
  #sttResultGaps: number[] = [];
  #stopped = false;

  public constructor(options: RuntimeHealthSamplerOptions) {
    this.#eventLoop = options.eventLoop;
    this.#now = options.now ?? (() => performance.now());
    this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#lastSampleAt = this.#now();
    this.#lastCpu = this.#cpuUsage();
    this.#eventLoop.enable();
  }

  public recordSttResult(at = this.#now()): void {
    if (this.#stopped) return;
    this.#sttResultCount += 1;
    if (this.#lastSttResultAt !== undefined) {
      this.#sttResultGaps.push(Math.max(0, at - this.#lastSttResultAt));
    }
    this.#lastSttResultAt = at;
  }

  public sample(): RuntimeHealthFields {
    const sampledAt = this.#now();
    const currentCpu = this.#cpuUsage();
    const elapsedMicroseconds = Math.max(1, (sampledAt - this.#lastSampleAt) * 1_000);
    const usedMicroseconds = Math.max(
      0,
      currentCpu.user - this.#lastCpu.user + currentCpu.system - this.#lastCpu.system,
    );
    const memory = this.#memoryUsage();
    const gapP95 = percentile95(this.#sttResultGaps);
    const gapMax = this.#sttResultGaps.length === 0
      ? null
      : Math.max(...this.#sttResultGaps);
    const fields: RuntimeHealthFields = {
      event_loop_p95_ms: round(this.#eventLoop.percentile(95) / 1_000_000, 3),
      event_loop_max_ms: round(this.#eventLoop.max / 1_000_000, 3),
      process_cpu_pct: round(usedMicroseconds / elapsedMicroseconds * 100, 2),
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      stt_result_count: this.#sttResultCount,
      stt_result_gap_p95_ms: gapP95 === null ? null : round(gapP95, 1),
      stt_result_gap_max_ms: gapMax === null ? null : round(gapMax, 1),
    };
    this.#lastSampleAt = sampledAt;
    this.#lastCpu = currentCpu;
    this.#sttResultCount = 0;
    this.#sttResultGaps = [];
    this.#eventLoop.reset();
    return fields;
  }

  public stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#eventLoop.disable();
  }
}

export type RuntimeHealthMonitor = {
  recordSttResult(): void;
  stop(): void;
};

export function startRuntimeHealthMonitor(
  write: (fields: RuntimeHealthFields) => void,
  intervalMs = 30_000,
): RuntimeHealthMonitor {
  const sampler = new RuntimeHealthSampler({
    eventLoop: monitorEventLoopDelay({ resolution: 20 }),
  });
  const timer = setInterval(() => write(sampler.sample()), intervalMs);
  timer.unref();
  let stopped = false;
  return {
    recordSttResult: () => sampler.recordSttResult(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      sampler.stop();
    },
  };
}
