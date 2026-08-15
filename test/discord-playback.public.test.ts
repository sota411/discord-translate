import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";

import { AudioPlayerStatus, type AudioPlayer } from "@discordjs/voice";

import { DiscordPlaybackGateway } from "../src/discord/playback-gateway.js";

class IdleBeforePlayingPlayer extends EventEmitter {
  public play(): void {
    queueMicrotask(() => this.emit(AudioPlayerStatus.Idle));
  }

  public stop(): boolean {
    this.emit(AudioPlayerStatus.Idle);
    return true;
  }
}

void test("PCMが一度もPlayingにならずIdleへ戻った場合は再生成功にしない", async () => {
  const player = new IdleBeforePlayingPlayer() as unknown as AudioPlayer;
  const gateway = new DiscordPlaybackGateway(player);

  await assert.rejects(
    gateway.play(Readable.from([], { objectMode: false })),
    /再生開始前/u,
  );
});
