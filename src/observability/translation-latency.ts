import { performance } from "node:perf_hooks";

export type TranslationLatencyStage =
  | "stt_endpoint"
  | "queue_started"
  | "caption_posted"
  | "tts_requested"
  | "tts_connection_ready"
  | "tts_text_sent"
  | "tts_first_audio"
  | "playback_started"
  | "tts_audio_end"
  | "pipeline_finished";

export type TranslationLatencyLogFields = {
  trace_id: string;
  stage: TranslationLatencyStage;
  stage_ms: number;
  total_ms: number;
};

export type TranslationLatencyRecorder = {
  start(traceId: string, sourceAudioEndedAtMonotonic: number): void;
  mark(traceId: string, stage: Exclude<TranslationLatencyStage, "stt_endpoint">): void;
  finish(traceId: string): void;
};

type TraceState = {
  startedAt: number;
  lastStageAt: number;
};

export function createTranslationLatencyRecorder(
  write: (fields: TranslationLatencyLogFields) => void,
  now: () => number = () => performance.now(),
): TranslationLatencyRecorder {
  const traces = new Map<string, TraceState>();
  const emit = (
    traceId: string,
    stage: TranslationLatencyStage,
    observedAt: number,
    state: TraceState,
  ): void => {
    write({
      trace_id: traceId,
      stage,
      stage_ms: Math.max(0, Math.round(observedAt - state.lastStageAt)),
      total_ms: Math.max(0, Math.round(observedAt - state.startedAt)),
    });
    state.lastStageAt = observedAt;
  };

  return {
    start: (traceId, sourceAudioEndedAtMonotonic) => {
      const observedAt = now();
      const state = {
        startedAt: sourceAudioEndedAtMonotonic,
        lastStageAt: sourceAudioEndedAtMonotonic,
      };
      traces.set(traceId, state);
      emit(traceId, "stt_endpoint", observedAt, state);
    },
    mark: (traceId, stage) => {
      const state = traces.get(traceId);
      if (!state) return;
      emit(traceId, stage, now(), state);
    },
    finish: (traceId) => {
      const state = traces.get(traceId);
      if (!state) return;
      emit(traceId, "pipeline_finished", now(), state);
      traces.delete(traceId);
    },
  };
}
