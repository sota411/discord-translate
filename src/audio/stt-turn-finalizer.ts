import type { RealtimeSttSession } from "@soniox/node";

export type SttBoundaryKind = "endpoint" | "finalized";
export type SttFinalizeReason =
  | "speaking_end"
  | "transcript_inactivity"
  | "max_turn_duration";
export type SttAcceptedFinalizeReason =
  | SttFinalizeReason
  | "soniox_endpoint"
  | "soniox_finalized";

type SttTurnFinalizerOptions = {
  session: Pick<RealtimeSttSession, "sendAudio" | "finalize">;
  speakingEndDelayMs: number;
  transcriptInactivityMs: number;
  maxTurnMs: number;
  trailingSilenceMs: number;
  onFinalize?: (reason: SttFinalizeReason) => void;
  onError?: (error: unknown) => void;
};

const pcmSampleRate = 48_000;
const pcmBytesPerSample = 2;

export class SttTurnFinalizer {
  readonly #session: SttTurnFinalizerOptions["session"];
  readonly #speakingEndDelayMs: number;
  readonly #transcriptInactivityMs: number;
  readonly #maxTurnMs: number;
  readonly #trailingSilenceMs: number;
  readonly #silence: Buffer;
  readonly #onFinalize: (reason: SttFinalizeReason) => void;
  readonly #onError: (error: unknown) => void;
  #speakingEndTimer: NodeJS.Timeout | undefined;
  #transcriptInactivityTimer: NodeJS.Timeout | undefined;
  #maxTurnTimer: NodeJS.Timeout | undefined;
  #hasPendingAudio = false;
  #manualFinalizeRequested = false;
  #manualFinalizeReason: SttFinalizeReason | undefined;
  #acceptedFinalizeReason: SttAcceptedFinalizeReason | undefined;
  #audioAfterFinalizeRequest = false;
  #transcriptProgressAfterFinalizeRequest = false;
  #ignoredFinalizedBoundaryCount = 0;
  #speaking = false;
  #closed = false;

  public constructor(options: SttTurnFinalizerOptions) {
    this.#session = options.session;
    this.#speakingEndDelayMs = options.speakingEndDelayMs;
    this.#transcriptInactivityMs = options.transcriptInactivityMs;
    this.#maxTurnMs = options.maxTurnMs;
    this.#trailingSilenceMs = options.trailingSilenceMs;
    this.#silence = Buffer.alloc(
      Math.round(pcmSampleRate * pcmBytesPerSample * options.trailingSilenceMs / 1_000),
    );
    this.#onFinalize = options.onFinalize ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
  }

  public audioReceived(): void {
    if (this.#closed) return;
    this.#hasPendingAudio = true;
    if (this.#manualFinalizeRequested) this.#audioAfterFinalizeRequest = true;
    else this.#scheduleMaxTurnTimer();
    if (!this.#speaking) this.#scheduleSpeakingEndFinalize();
  }

  public speakingStarted(): void {
    this.#speaking = true;
    this.#clearSpeakingEndTimer();
  }

  public speakingEnded(): void {
    this.#speaking = false;
    this.#scheduleSpeakingEndFinalize();
  }

  #scheduleSpeakingEndFinalize(): void {
    if (this.#closed || !this.#hasPendingAudio || this.#manualFinalizeRequested) return;
    this.#clearSpeakingEndTimer();
    this.#speakingEndTimer = setTimeout(() => {
      this.#speakingEndTimer = undefined;
      this.#requestFinalize("speaking_end");
    }, this.#speakingEndDelayMs);
    this.#speakingEndTimer.unref();
  }

  public transcriptProgressed(): void {
    if (this.#closed) return;
    this.#hasPendingAudio = true;
    if (this.#manualFinalizeRequested) {
      this.#transcriptProgressAfterFinalizeRequest = true;
      return;
    }
    this.#scheduleTranscriptTimers();
  }

  #scheduleTranscriptTimers(): void {
    this.#scheduleMaxTurnTimer();
    this.#clearTranscriptInactivityTimer();
    this.#transcriptInactivityTimer = setTimeout(() => {
      this.#transcriptInactivityTimer = undefined;
      this.#requestFinalize("transcript_inactivity");
    }, this.#transcriptInactivityMs);
    this.#transcriptInactivityTimer.unref();
  }

  #scheduleMaxTurnTimer(): void {
    if (!this.#maxTurnTimer) {
      this.#maxTurnTimer = setTimeout(() => {
        this.#maxTurnTimer = undefined;
        this.#requestFinalize("max_turn_duration");
      }, this.#maxTurnMs);
      this.#maxTurnTimer.unref();
    }
  }

  public boundaryReceived(kind: SttBoundaryKind): boolean {
    if (kind === "finalized" && this.#ignoredFinalizedBoundaryCount > 0) {
      this.#ignoredFinalizedBoundaryCount -= 1;
      return false;
    }

    this.#acceptedFinalizeReason = this.#manualFinalizeReason ??
      (kind === "endpoint" ? "soniox_endpoint" : "soniox_finalized");
    this.#clearTimers();
    if (kind === "endpoint" && this.#manualFinalizeRequested) {
      this.#ignoredFinalizedBoundaryCount += 1;
    }
    const hadAudioAfterFinalizeRequest = this.#audioAfterFinalizeRequest;
    this.#hasPendingAudio = hadAudioAfterFinalizeRequest || this.#speaking;
    this.#manualFinalizeRequested = false;
    this.#manualFinalizeReason = undefined;
    this.#audioAfterFinalizeRequest = false;
    const transcriptProgressed = this.#transcriptProgressAfterFinalizeRequest;
    this.#transcriptProgressAfterFinalizeRequest = false;
    if (hadAudioAfterFinalizeRequest) this.#scheduleMaxTurnTimer();
    if (transcriptProgressed && hadAudioAfterFinalizeRequest) {
      this.#scheduleTranscriptTimers();
    }
    if (this.#hasPendingAudio && !this.#speaking) {
      this.#scheduleSpeakingEndFinalize();
    }
    return true;
  }

  public takeAcceptedFinalizeReason(): SttAcceptedFinalizeReason | undefined {
    const reason = this.#acceptedFinalizeReason;
    this.#acceptedFinalizeReason = undefined;
    return reason;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
  }

  #requestFinalize(reason: SttFinalizeReason): void {
    if (this.#closed || !this.#hasPendingAudio || this.#manualFinalizeRequested) return;
    this.#clearTimers();
    try {
      this.#session.sendAudio(this.#silence);
      this.#session.finalize({ trailing_silence_ms: this.#trailingSilenceMs });
      this.#manualFinalizeRequested = true;
      this.#manualFinalizeReason = reason;
      this.#onFinalize(reason);
    } catch (error) {
      this.#onError(error);
    }
  }

  #clearTimers(): void {
    this.#clearSpeakingEndTimer();
    this.#clearTranscriptInactivityTimer();
    if (this.#maxTurnTimer) {
      clearTimeout(this.#maxTurnTimer);
      this.#maxTurnTimer = undefined;
    }
  }

  #clearSpeakingEndTimer(): void {
    if (!this.#speakingEndTimer) return;
    clearTimeout(this.#speakingEndTimer);
    this.#speakingEndTimer = undefined;
  }

  #clearTranscriptInactivityTimer(): void {
    if (!this.#transcriptInactivityTimer) return;
    clearTimeout(this.#transcriptInactivityTimer);
    this.#transcriptInactivityTimer = undefined;
  }
}
