import {
  SonioxNodeClient,
  type ConcurrencyLimitsResponse,
  type RealtimeSttSession,
  type SonioxModel,
  type TtsModel,
} from "@soniox/node";

import { ConfigError, type AppConfig } from "../config.js";
import type { TranslationTerms } from "../config/translation-terms.js";
import { ApplicationError } from "../domain/application-error.js";
import {
  languagePairs,
  languagesForPair,
  type LanguagePair,
} from "../domain/language-pair.js";
import type { CapacityGate } from "../session/session-manager.js";
import { usdDecimalToMicrousd } from "../usage/usage-ledger.js";

type RequestDeadline = {
  signal: AbortSignal;
  clear(): void;
};

function createRequestDeadline(timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Soniox API request timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

type ConcurrencyClient = {
  concurrencyLimits: {
    get(signal?: AbortSignal): Promise<ConcurrencyLimitsResponse>;
  };
};

function scopeHasCapacity(
  scope: ConcurrencyLimitsResponse["project"],
  sttStreams: number,
  ttsStreams: number,
): boolean {
  const sttAvailable = scope.limits.transcribe_concurrent === null ||
    scope.current.transcribe_concurrent + sttStreams <= scope.limits.transcribe_concurrent;
  const ttsAvailable = scope.limits.tts_concurrent === null ||
    scope.current.tts_concurrent + ttsStreams <= scope.limits.tts_concurrent;
  return sttAvailable && ttsAvailable;
}

export function hasSonioxCapacity(
  response: ConcurrencyLimitsResponse,
  sttStreams: number,
  ttsStreams: number,
): boolean {
  return scopeHasCapacity(response.project, sttStreams, ttsStreams) &&
    scopeHasCapacity(response.organization, sttStreams, ttsStreams);
}

export class SonioxCapacityGate implements CapacityGate {
  readonly #client: ConcurrencyClient;
  readonly #timeoutMs: number;

  public constructor(client: ConcurrencyClient, timeoutMs = 30_000) {
    this.#client = client;
    this.#timeoutMs = timeoutMs;
  }

  public async assertCanStart(input: {
    sttStreams: number;
    ttsStreams: number;
    at: Date;
  }): Promise<void> {
    const deadline = createRequestDeadline(this.#timeoutMs);
    try {
      const limits = await awaitWithAbort(
        this.#client.concurrencyLimits.get(deadline.signal),
        deadline.signal,
      );
      if (!hasSonioxCapacity(limits, input.sttStreams, input.ttsStreams)) {
        throw new ApplicationError(
          "SONIOX_CAPACITY_UNAVAILABLE",
          "Sonioxの同時実行枠に空きがありません。時間を置いて再実行してください。",
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "SONIOX_CAPACITY_UNAVAILABLE",
        "Sonioxの同時実行枠を確認できないため、翻訳を開始しません。",
        { cause: error },
      );
    } finally {
      deadline.clear();
    }
  }
}

export function createSonioxClient(config: AppConfig["soniox"]): SonioxNodeClient {
  return new SonioxNodeClient({
    api_key: config.apiKey,
    region: config.region,
    base_url: config.restBaseUrl,
    tts_api_url: config.ttsRestBaseUrl,
    realtime: {
      ws_base_url: config.sttWebSocketUrl,
      tts_ws_url: config.ttsWebSocketUrl,
    },
  });
}

type PreflightClient = {
  models: { list(signal?: AbortSignal): Promise<SonioxModel[]> };
  tts: { listModels(signal?: AbortSignal): Promise<TtsModel[]> };
};

function supportsPair(model: SonioxModel, pair: LanguagePair): boolean {
  if (model.two_way_translation === "all_languages") return true;
  const [a, b] = languagesForPair(pair);
  return model.two_way_translation_pairs.includes(pair) ||
    model.two_way_translation_pairs.includes(`${b}-${a}`);
}

export async function verifySonioxConfiguration(
  client: PreflightClient,
  config: Pick<AppConfig["soniox"], "sttModel" | "ttsModel" | "voices">,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = createRequestDeadline(timeoutMs);
  try {
    const [sttModels, ttsModels] = await awaitWithAbort(
      Promise.all([
        client.models.list(deadline.signal),
        client.tts.listModels(deadline.signal),
      ]),
      deadline.signal,
    );
    const sttModel = sttModels.find((model) => model.id === config.sttModel);
    const ttsModel = ttsModels.find((model) => model.id === config.ttsModel);
    const issues: string[] = [];
    if (!sttModel) {
      issues.push(`STT model「${config.sttModel}」を利用できません`);
    } else {
      const supportedLanguages = new Set(sttModel.languages.map((language) => language.code));
      for (const language of ["ja", "ko", "en"] as const) {
        if (!supportedLanguages.has(language)) issues.push(`STT modelが${language}に未対応です`);
      }
      for (const pair of languagePairs) {
        if (!supportsPair(sttModel, pair)) issues.push(`STT modelが${pair}の双方向翻訳に未対応です`);
      }
    }
    if (!ttsModel) {
      issues.push(`TTS model「${config.ttsModel}」を利用できません`);
    } else {
      const supportedLanguages = new Set(ttsModel.languages.map((language) => language.code));
      for (const language of ["ja", "ko", "en"] as const) {
        if (!supportedLanguages.has(language)) issues.push(`TTS modelが${language}に未対応です`);
      }
      const voices = new Set(ttsModel.voices.map((voice) => voice.id));
      for (const [language, voice] of Object.entries(config.voices)) {
        if (!voices.has(voice)) issues.push(`SONIOX_VOICE_${language.toUpperCase()}「${voice}」を利用できません`);
      }
      if (!ttsModel.supports_silence_reduction) {
        issues.push("TTS modelが無音短縮に未対応です");
      }
    }
    if (issues.length > 0) {
      throw new ConfigError(issues);
    }
  } finally {
    deadline.clear();
  }
}

export class SonioxSttFactory {
  readonly #client: SonioxNodeClient;
  readonly #model: string;
  readonly #terms: TranslationTerms;

  public constructor(client: SonioxNodeClient, model: string, terms: TranslationTerms) {
    this.#client = client;
    this.#model = model;
    this.#terms = terms;
  }

  public create(pair: LanguagePair, requestRef: string): {
    session: RealtimeSttSession;
    initialTextCharacterCount: number;
  } {
    const [languageA, languageB] = languagesForPair(pair);
    const translationTerms = this.#terms[pair];
    const session = this.#client.realtime.stt({
      model: this.#model,
      audio_format: "pcm_s16le",
      sample_rate: 48_000,
      num_channels: 1,
      language_hints: [languageA, languageB],
      enable_language_identification: true,
      enable_endpoint_detection: true,
      translation: {
        type: "two_way",
        language_a: languageA,
        language_b: languageB,
      },
      client_reference_id: requestRef,
      ...(translationTerms.length > 0
        ? { context: { translation_terms: [...translationTerms] } }
        : {}),
    });
    return {
      session,
      initialTextCharacterCount: translationTerms.length > 0
        ? Array.from(JSON.stringify(translationTerms)).length
        : 0,
    };
  }
}

type UsageLogClient = {
  usageLogs: {
    list(options: {
      start_time: string;
      end_time: string;
      sort: "end_time_asc";
      limit: number;
      signal?: AbortSignal;
    }): Promise<AsyncIterable<{
      client_reference_id?: string | null | undefined;
      cost_usd: string;
    }>>;
  };
};

type ReconciliationLedger = {
  getLastReconciledAt(): Date | undefined;
  hasProviderRequest(requestRef: string): boolean;
  reconcileProviderRequest(requestRef: string, costMicrousd: number, at: Date): void;
  markReconciled(at: Date): void;
};

const reconciliationOverlapMs = 5 * 60 * 1000;
const initialReconciliationWindowMs = 30 * 24 * 60 * 60 * 1000;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Soniox API request aborted", { cause: signal.reason });
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error
          ? error
          : new Error("Soniox API request failed", { cause: error }));
      },
    );
  });
}

export class SonioxUsageReconciler {
  readonly #client: UsageLogClient;
  readonly #ledger: ReconciliationLedger;
  readonly #timeoutMs: number;

  public constructor(
    client: UsageLogClient,
    ledger: ReconciliationLedger,
    timeoutMs = 30_000,
  ) {
    this.#client = client;
    this.#ledger = ledger;
    this.#timeoutMs = timeoutMs;
  }

  public async reconcile(at: Date): Promise<void> {
    const last = this.#ledger.getLastReconciledAt();
    const startMs = last && last.getTime() <= at.getTime()
      ? Math.max(
          last.getTime() - reconciliationOverlapMs,
          at.getTime() - initialReconciliationWindowMs,
        )
      : at.getTime() - initialReconciliationWindowMs;
    const deadline = createRequestDeadline(this.#timeoutMs);
    try {
      const result = await awaitWithAbort(
        this.#client.usageLogs.list({
          start_time: new Date(startMs).toISOString(),
          end_time: at.toISOString(),
          sort: "end_time_asc",
          limit: 1_000,
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      const iterator = result[Symbol.asyncIterator]();
      let next = await awaitWithAbort(iterator.next(), deadline.signal);
      while (!next.done) {
        const log = next.value;
        const requestRef = log.client_reference_id;
        if (requestRef && this.#ledger.hasProviderRequest(requestRef)) {
          this.#ledger.reconcileProviderRequest(
            requestRef,
            usdDecimalToMicrousd(log.cost_usd),
            at,
          );
        }
        next = await awaitWithAbort(iterator.next(), deadline.signal);
      }
      this.#ledger.markReconciled(at);
    } finally {
      deadline.clear();
    }
  }
}

type UsageReconciler = {
  reconcile(at: Date): Promise<void>;
};

type ReconciliationJob = {
  at: Date;
  promise: Promise<void>;
  resolve: () => void;
};

function createReconciliationJob(at: Date): ReconciliationJob {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((jobResolved) => {
    resolve = jobResolved;
  });
  return { at, promise, resolve };
}

export class SonioxUsageReconciliationQueue {
  readonly #reconciler: UsageReconciler;
  readonly #onError: (error: unknown) => void;
  readonly #requiredJobs: ReconciliationJob[] = [];
  readonly #idleWaiters: (() => void)[] = [];
  #periodicJob: ReconciliationJob | undefined;
  #running = false;

  public constructor(
    reconciler: UsageReconciler,
    onError: (error: unknown) => void,
  ) {
    this.#reconciler = reconciler;
    this.#onError = onError;
  }

  public schedule(at: Date): Promise<void> {
    const job = createReconciliationJob(at);
    this.#requiredJobs.push(job);
    this.#start();
    return job.promise;
  }

  public schedulePeriodic(at: Date): Promise<void> {
    if (this.#periodicJob) {
      this.#periodicJob.at = at;
      return this.#periodicJob.promise;
    }

    const job = createReconciliationJob(at);
    this.#periodicJob = job;
    this.#start();
    return job.promise;
  }

  public wait(): Promise<void> {
    if (!this.#running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  #start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    let job = this.#nextJob();
    while (job) {
      try {
        await this.#reconciler.reconcile(job.at);
      } catch (error) {
        this.#onError(error);
      } finally {
        job.resolve();
      }
      job = this.#nextJob();
    }

    this.#running = false;
    for (const resolve of this.#idleWaiters.splice(0)) {
      resolve();
    }
  }

  #nextJob(): ReconciliationJob | undefined {
    const required = this.#requiredJobs.shift();
    if (required) {
      return required;
    }
    const periodic = this.#periodicJob;
    this.#periodicJob = undefined;
    return periodic;
  }
}
