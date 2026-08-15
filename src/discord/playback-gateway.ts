import type { Readable } from "node:stream";

import {
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
  type AudioPlayer,
  type AudioPlayerError,
} from "@discordjs/voice";

import { MonoToStereoTransform } from "../audio/pcm.js";
import type { PlaybackGateway } from "../translation/utterance-processor.js";

export class DiscordPlaybackGateway implements PlaybackGateway {
  readonly #player: AudioPlayer;

  public constructor(player: AudioPlayer) {
    this.#player = player;
  }

  public play(audio: Readable): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stereo = new MonoToStereoTransform();
      const cleanup = (): void => {
        this.#player.off(AudioPlayerStatus.Idle, onIdle);
        this.#player.off("error", onPlayerError);
        audio.off("error", onStreamError);
        stereo.off("error", onStreamError);
      };
      const onIdle = (): void => {
        cleanup();
        resolve();
      };
      const onPlayerError = (error: AudioPlayerError): void => {
        cleanup();
        reject(error);
      };
      const onStreamError = (error: Error): void => {
        cleanup();
        this.#player.stop(true);
        reject(error);
      };

      this.#player.once(AudioPlayerStatus.Idle, onIdle);
      this.#player.once("error", onPlayerError);
      audio.once("error", onStreamError);
      stereo.once("error", onStreamError);
      audio.pipe(stereo);
      this.#player.play(createAudioResource(stereo, { inputType: StreamType.Raw }));
    });
  }

  public stop(): void {
    this.#player.stop(true);
  }
}
