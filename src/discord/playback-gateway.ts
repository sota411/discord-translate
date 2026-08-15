import type { Readable } from "node:stream";

import {
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
  type AudioPlayer,
  type AudioPlayerError,
} from "@discordjs/voice";

import { MonoToStereoTransform } from "../audio/pcm.js";
import type { TranslationLatencyRecorder } from "../observability/translation-latency.js";
import type { PlaybackGateway } from "../translation/utterance-processor.js";

export class DiscordPlaybackGateway implements PlaybackGateway {
  readonly #player: AudioPlayer;
  readonly #latency: TranslationLatencyRecorder | undefined;
  #stopActive: (() => void) | undefined;

  public constructor(player: AudioPlayer, latency?: TranslationLatencyRecorder) {
    this.#player = player;
    this.#latency = latency;
  }

  public play(
    audio: Readable,
    traceId?: string,
    onStarted?: () => void,
  ): Promise<void> {
    if (this.#stopActive) {
      return Promise.reject(new Error("Discord音声の再生要求が重複しました。"));
    }
    return new Promise<void>((resolve, reject) => {
      const stereo = new MonoToStereoTransform();
      let playing = false;
      let stopRequested = false;
      let settled = false;
      const cleanup = (): void => {
        this.#player.off(AudioPlayerStatus.Idle, onIdle);
        this.#player.off(AudioPlayerStatus.Playing, onPlaying);
        this.#player.off("error", onPlayerError);
        audio.off("error", onStreamError);
        stereo.off("error", onStreamError);
        this.#stopActive = undefined;
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onIdle = (): void => {
        if (stopRequested) {
          settle(new Error("Discord音声の再生が明示的に中断されました。"));
        } else if (!playing) {
          settle(new Error("Discord音声が再生開始前に終了しました。"));
        } else {
          settle();
        }
      };
      const onPlaying = (): void => {
        playing = true;
        onStarted?.();
        if (traceId) this.#latency?.mark(traceId, "playback_started");
      };
      const onPlayerError = (error: AudioPlayerError): void => {
        settle(error);
      };
      const onStreamError = (error: Error): void => {
        settle(error);
        this.#player.stop(true);
      };

      this.#player.once(AudioPlayerStatus.Idle, onIdle);
      this.#player.once(AudioPlayerStatus.Playing, onPlaying);
      this.#player.once("error", onPlayerError);
      audio.once("error", onStreamError);
      stereo.once("error", onStreamError);
      this.#stopActive = () => {
        stopRequested = true;
        if (!this.#player.stop(true)) onIdle();
      };
      audio.pipe(stereo);
      this.#player.play(createAudioResource(stereo, { inputType: StreamType.Raw }));
    });
  }

  public stop(): void {
    if (this.#stopActive) this.#stopActive();
    else this.#player.stop(true);
  }
}
