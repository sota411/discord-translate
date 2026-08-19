export const playbackModes = ["conversation", "accuracy"] as const;
export const conversationAudioMaxDelayMs = 2_500;

export type PlaybackMode = (typeof playbackModes)[number];

export const playbackModeLabels: Readonly<Record<PlaybackMode, string>> = {
  conversation: "会話優先",
  accuracy: "正確さ優先",
};

export const captionFailurePolicies = ["continue_audio", "stop_session"] as const;

export type CaptionFailurePolicy = (typeof captionFailurePolicies)[number];

export const captionFailurePolicyLabels: Readonly<Record<CaptionFailurePolicy, string>> = {
  continue_audio: "音声翻訳を継続",
  stop_session: "セッションを停止",
};

export function isPlaybackMode(value: string): value is PlaybackMode {
  return playbackModes.includes(value as PlaybackMode);
}

export function isCaptionFailurePolicy(value: string): value is CaptionFailurePolicy {
  return captionFailurePolicies.includes(value as CaptionFailurePolicy);
}
