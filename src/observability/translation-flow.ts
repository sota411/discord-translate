export type TranslationFlowStage =
  | "voice_speaking_started"
  | "voice_first_packet_received"
  | "voice_speaking_ended"
  | "stt_endpoint_empty"
  | "stt_endpoint_finalized"
  | "tts_prefetch_started"
  | "tts_prefetch_ready"
  | "tts_prefetch_pending";

export type TranslationFlowObserver = (stage: TranslationFlowStage) => void;
