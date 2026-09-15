import { randomUUID } from "node:crypto";
import type { RealtimeSttSession } from "@soniox/node";

import type { DolphinWorker } from "../audio/dolphin-worker.js";
import type { RefinementWork } from "../audio/refinement-fence.js";
import type { TranslationTerm } from "../config/translation-terms.js";
import type { Language } from "../domain/language-pair.js";
import type { SessionDescriptor } from "../session/session-manager.js";
import { StreamingUtterance } from "../translation/streaming-utterance.js";
import type { FinalizedUtterance } from "../translation/token-assembler.js";
import type { UsageLedger } from "../usage/usage-ledger.js";
import type { SonioxSttFactory } from "./control.js";

export type RefinementOutcome = "completed" | "unchanged" | "busy" | "deadline" | "ineligible";
type Options = {
  worker: DolphinWorker;
  factory: SonioxSttFactory;
  ledger: UsageLedger;
  maxInputCharacters: number;
};
type Start = {
  session: Pick<SessionDescriptor, "sessionId" | "guildId" | "pair">;
  userId: string;
  hint: { language: Language; strict: boolean } | undefined;
  terms: readonly TranslationTerm[];
  observe: (outcome: RefinementOutcome) => void;
  onError: (error: unknown) => void;
};

export class SpeechRefinement {
  readonly #options: Options;
  // ponytail: one job across calls bounds CPU, memory, and one extra Soniox slot.
  // Add a measured queue only if simultaneous speech needs another worker.
  #busy = false;

  public constructor(options: Options) { this.#options = options; }

  public start(input: Start): RefinementWork | undefined {
    if (input.session.pair !== "ja-ko") return undefined;
    if (this.#busy) { input.observe("busy"); return undefined; }
    this.#busy = true;
    const { worker, factory, ledger, maxInputCharacters } = this.#options;
    const prefixBytes = input.hint?.language === "ja" ? 230_400 : 288_000;
    let chunks: Buffer[] = [];
    let bytes = 0;
    let sentBytes = 0;
    let connectedAt: number | undefined;
    let characters = 0;
    let request: { session: RealtimeSttSession; ref: string } | undefined;
    let local: Promise<void> | undefined;
    let finished = false;
    let ready = false;
    let stopped = false;
    const isStopped = (): boolean => stopped;
    let disposed = false;
    let finishStarted = false;
    let settled = false;
    let boundaries = 0;
    const sourceLanguages = new Set<string>();
    let result: FinalizedUtterance | undefined;
    let selected: { primary: FinalizedUtterance; deliver: (value: FinalizedUtterance) => void } | undefined;
    let outcome: RefinementOutcome = "ineligible";
    let deadline: NodeJS.Timeout | undefined;
    const utterance = new StreamingUtterance({ pair: input.session.pair,
      maxSourceDurationMs: 8_000, maxInputCharacters });

    const closeRequest = (status: "completed" | "failed"): void => {
      const current = request;
      if (!current) return;
      request = undefined;
      const errors: unknown[] = [];
      try { current.session.close(); } catch (error) { errors.push(error); }
      try {
        ledger.recordProviderUsage({ requestRef: current.ref,
          audioMs: Math.max(Math.ceil(sentBytes / 96), connectedAt === undefined ? 0 : Math.ceil(performance.now() - connectedAt)),
          textCharacterCount: characters, at: new Date() });
      } catch (error) { errors.push(error); }
      try { ledger.finishProviderRequest(current.ref, status, new Date()); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "補助認識の利用量を確定できませんでした");
    };
    const deliver = (): void => {
      if (!selected || !stopped || disposed) return;
      const current = selected;
      selected = undefined;
      input.observe(outcome);
      current.deliver(result ?? current.primary);
    };
    const stop = (status: "completed" | "failed" = "completed"): void => {
      if (isStopped()) { deliver(); return; }
      stopped = true;
      clearTimeout(deadline);
      chunks = [];
      try { closeRequest(status); }
      catch (error) { disposed = true; input.onError(error); }
      finally {
        // Cancellation must not release the CPU slot while native decoding runs.
        void (local ?? Promise.resolve()).finally(() => { this.#busy = false; });
        deliver();
      }
    };
    const fail = (error: unknown): void => {
      if (isStopped()) return;
      disposed = true;
      try { stop("failed"); } catch (cleanup) { input.onError(cleanup); }
      input.onError(error);
    };
    const completeCloud = (): void => {
      if (!request || !ready || !finished || stopped || finishStarted) return;
      finishStarted = true;
      request.session.sendAudio(Buffer.alloc(19_200));
      sentBytes += 19_200;
      void request.session.finish().then(() => {
        if (isStopped()) return;
        const refined = utterance.takeAtEndpoint();
        if (boundaries === 1 && sourceLanguages.size === 1 && refined?.translatedText.trim()) {
          result = refined;
          outcome = "completed";
        }
        settled = true;
        // Wait for the primary fence before choosing a replacement.
        stop();
      }).catch(fail);
    };
    const begin = (): void => {
      if (local || stopped) return;
      const pcm = Buffer.concat(chunks, bytes).subarray(0, prefixBytes);
      local = (async () => {
        const text = await worker.transcribe(pcm);
        if (isStopped()) return;
        if (!text.trim()) { stop(); return; }
        await ledger.assertCanStart({ guildId: input.session.guildId, userIds: [input.userId], at: new Date() });
        if (isStopped()) return;
        const ref = randomUUID();
        const created = factory.create(input.session.pair, ref, input.terms, input.hint, text);
        characters = created.initialTextCharacterCount;
        ledger.openProviderRequest({ requestRef: ref, sessionId: input.session.sessionId,
          userId: input.userId, kind: "stt", startedAt: new Date() });
        request = { ref, session: created.session };
        const current = request;
        current.session.on("error", fail);
        current.session.on("endpoint", () => { boundaries += 1; });
        current.session.on("result", (response) => {
          if (isStopped()) return;
          try {
            for (const token of response.tokens) {
              characters += Array.from(token.text).length;
              if (token.is_final && token.translation_status === "original" && token.language && token.text.trim()) {
                sourceLanguages.add(token.language);
              }
            }
            utterance.accept(response.tokens);
          } catch (error) { fail(error); }
        });
        await current.session.connect();
        if (isStopped()) { current.session.close(); return; }
        connectedAt = performance.now();
        ready = true;
        const buffered = Buffer.concat(chunks, bytes);
        current.session.sendAudio(buffered);
        sentBytes += buffered.length;
        chunks = [];
        completeCloud();
      })().catch(fail);
    };
    return {
      push: (audio) => {
        if (stopped || finished) return;
        if (audio.length % 2) throw new TypeError("補助認識のPCM長が不正です");
        bytes += audio.length;
        if (bytes > 768_000) { stop(); return; }
        if (ready && request) { request.session.sendAudio(audio); sentBytes += audio.length; }
        else chunks.push(Buffer.from(audio));
        if (bytes >= prefixBytes) begin();
      },
      finish: (lastAudioAt) => {
        if (stopped || finished) return;
        finished = true;
        const remaining = lastAudioAt + 2_390 - performance.now();
        if (remaining <= 0) { outcome = "deadline"; stop(); return; }
        deadline = setTimeout(() => {
          outcome = "deadline";
          try { stop(); } catch (error) { input.onError(error); }
        }, remaining);
        begin();
        completeCloud();
      },
      choose: (primary, send) => {
        if (disposed) return;
        selected = { primary, deliver: send };
        if (settled && result?.originalText === primary.originalText && result.translatedText === primary.translatedText) {
          outcome = "unchanged";
        }
        deliver();
      },
      cancel: () => { if (!settled) outcome = "ineligible"; result = undefined; stop(); },
      close: () => { disposed = true; selected = undefined; stop(); },
    };
  }
}
