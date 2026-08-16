import type { SttFinalizeReason } from "../audio/stt-turn-finalizer.js";

export type TranslationFlowStage =
  | "voice_speaking_started"
  | "voice_first_packet_received"
  | "voice_packet_dropped"
  | "voice_startup_buffer_overflow"
  | "voice_speaking_ended"
  | "stt_manual_finalize_speaking_end"
  | "stt_manual_finalize_inactivity"
  | "stt_manual_finalize_max_duration"
  | "stt_endpoint_empty"
  | "stt_endpoint_finalized";

const sttFinalizeFlowStages: Readonly<Record<SttFinalizeReason, TranslationFlowStage>> = {
  speaking_end: "stt_manual_finalize_speaking_end",
  transcript_inactivity: "stt_manual_finalize_inactivity",
  max_turn_duration: "stt_manual_finalize_max_duration",
};

export function sttFinalizeFlowStage(reason: SttFinalizeReason): TranslationFlowStage {
  return sttFinalizeFlowStages[reason];
}

export type TranslationFlowObserver = (stage: TranslationFlowStage) => void;
