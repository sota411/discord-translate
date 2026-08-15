export type TranslationFlowStage =
  | "voice_speaking_started"
  | "voice_first_packet_received"
  | "voice_packet_dropped"
  | "voice_speaking_ended"
  | "stt_endpoint_empty"
  | "stt_endpoint_finalized";

export type TranslationFlowObserver = (stage: TranslationFlowStage) => void;
