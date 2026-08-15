import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TranslationCommandService,
  type StartCommandInput,
} from "../src/commands/translation-command-service.js";
import {
  SessionManager,
  type CapacityGate,
  type SessionRuntime,
  type TranslationSessionDriver,
  type UsageGate,
} from "../src/session/session-manager.js";

type Harness = {
  service: TranslationCommandService;
  driver: RecordingDriver;
  usageGate: RecordingUsageGate;
  capacityGate: RecordingCapacityGate;
};

class RecordingUsageGate implements UsageGate {
  public calls = 0;

  public assertCanStart(): Promise<void> {
    this.calls += 1;
    return Promise.resolve();
  }
}

class RecordingCapacityGate implements CapacityGate {
  public calls = 0;
  public wait: Promise<void> = Promise.resolve();

  public async assertCanStart(): Promise<void> {
    this.calls += 1;
    await this.wait;
  }
}

class RecordingRuntime implements SessionRuntime {
  public readonly updates: string[][] = [];
  public readonly stopReasons: string[] = [];

  public updateParticipants(participantIds: readonly string[]): Promise<void> {
    this.updates.push([...participantIds]);
    return Promise.resolve();
  }

  public stop(reason: string): Promise<void> {
    this.stopReasons.push(reason);
    return Promise.resolve();
  }
}

class RecordingDriver implements TranslationSessionDriver {
  public readonly starts: { guildId: string; participantIds: readonly string[] }[] = [];
  public readonly runtimes: RecordingRuntime[] = [];

  public start(
    session: { guildId: string },
    participantIds: readonly string[],
  ): Promise<SessionRuntime> {
    this.starts.push({ guildId: session.guildId, participantIds: [...participantIds] });
    const runtime = new RecordingRuntime();
    this.runtimes.push(runtime);
    return Promise.resolve(runtime);
  }
}

function createHarness(): Harness {
  const driver = new RecordingDriver();
  const usageGate = new RecordingUsageGate();
  const capacityGate = new RecordingCapacityGate();
  const sessions = new SessionManager({
    driver,
    usageGate,
    capacityGate,
    now: () => new Date("2026-08-15T03:00:00Z"),
    createId: () => "00000000-0000-4000-8000-000000000001",
  });
  const service = new TranslationCommandService({
    allowedGuildIds: new Set(["223456789012345678"]),
    allowedUserIds: new Set([
      "323456789012345678",
      "423456789012345678",
    ]),
    maxSpeakersPerSession: 2,
    sessions,
  });
  return { service, driver, usageGate, capacityGate };
}

function validStart(overrides: Partial<StartCommandInput> = {}): StartCommandInput {
  return {
    kind: "start",
    pair: "ja-ko",
    guildId: "223456789012345678",
    actorId: "323456789012345678",
    actorCanManageGuild: false,
    voiceChannel: {
      id: "523456789012345678",
      name: "General",
      humanParticipantIds: ["323456789012345678", "423456789012345678"],
    },
    textChannel: {
      id: "623456789012345678",
      name: "translation",
    },
    botPermissions: {
      voice: { viewChannel: true, connect: true, speak: true },
      text: { viewChannel: true, sendMessages: true },
    },
    ...overrides,
  };
}

void test("未許可Guildは外部利用量確認や音声接続より前に拒否する", async () => {
  const harness = createHarness();

  const result = await harness.service.execute(
    validStart({ guildId: "999999999999999999" }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "GUILD_NOT_ALLOWED");
  assert.equal(result.ephemeral, true);
  assert.equal(harness.usageGate.calls, 0);
  assert.equal(harness.capacityGate.calls, 0);
  assert.equal(harness.driver.starts.length, 0);
});

void test("音声チャンネルに未許可の人間がいれば、その音声を接続前に拒否する", async () => {
  const harness = createHarness();
  const result = await harness.service.execute(
    validStart({
      voiceChannel: {
        id: "523456789012345678",
        name: "General",
        humanParticipantIds: ["323456789012345678", "999999999999999999"],
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "SPEAKER_NOT_ALLOWED");
  assert.equal(harness.driver.starts.length, 0);
});

void test("必要権限が不足していれば、不足箇所を示して接続しない", async () => {
  const harness = createHarness();
  const result = await harness.service.execute(
    validStart({
      botPermissions: {
        voice: { viewChannel: true, connect: false, speak: true },
        text: { viewChannel: true, sendMessages: false },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "BOT_PERMISSION_MISSING");
  assert.match(result.interactionMessage, /Connect/);
  assert.match(result.interactionMessage, /SendMessages/);
  assert.equal(harness.driver.starts.length, 0);
});

void test("許可条件を満たすと利用量・容量を確認して1セッションだけ開始する", async () => {
  const harness = createHarness();

  const result = await harness.service.execute(validStart());

  assert.equal(result.ok, true);
  assert.equal(result.ephemeral, true);
  assert.equal(result.publicMessage?.channelId, "623456789012345678");
  assert.ok(result.publicMessage);
  assert.match(result.publicMessage.content, /音声は.*Soniox/u);
  assert.equal(harness.usageGate.calls, 1);
  assert.equal(harness.capacityGate.calls, 1);
  assert.equal(harness.driver.starts.length, 1);
});

void test("同じGuildへの同時startはAUTHORIZING中から排他する", async () => {
  const harness = createHarness();
  let releaseCapacity: (() => void) | undefined;
  harness.capacityGate.wait = new Promise<void>((resolve) => {
    releaseCapacity = resolve;
  });

  const first = harness.service.execute(validStart());
  await Promise.resolve();
  const second = await harness.service.execute(validStart());

  assert.equal(second.ok, false);
  assert.equal(second.code, "SESSION_ALREADY_ACTIVE");
  releaseCapacity?.();
  assert.equal((await first).ok, true);
  assert.equal(harness.driver.starts.length, 1);
});

void test("未許可Userの途中参加時はruntimeへ追加せずセッションを停止する", async () => {
  const harness = createHarness();
  assert.equal((await harness.service.execute(validStart())).ok, true);

  const result = await harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    ["323456789012345678", "999999999999999999"],
  );

  assert.equal(result.stopped, true);
  assert.equal(result.reason, "SPEAKER_NOT_ALLOWED");
  const runtime = harness.driver.runtimes[0];
  assert.ok(runtime);
  assert.deepEqual(runtime.updates, []);
  assert.deepEqual(runtime.stopReasons, ["SPEAKER_NOT_ALLOWED"]);
});

void test("開始者、対象VC参加者、ManageGuild保持者だけが停止できる", async () => {
  const harness = createHarness();
  assert.equal((await harness.service.execute(validStart())).ok, true);

  const denied = await harness.service.execute({
    kind: "stop",
    guildId: "223456789012345678",
    actorId: "999999999999999999",
    actorCanManageGuild: false,
    actorVoiceChannelId: undefined,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "STOP_NOT_ALLOWED");

  const stopped = await harness.service.execute({
    kind: "stop",
    guildId: "223456789012345678",
    actorId: "423456789012345678",
    actorCanManageGuild: false,
    actorVoiceChannelId: "523456789012345678",
  });
  assert.equal(stopped.ok, true);
  assert.deepEqual(harness.driver.runtimes[0]?.stopReasons, ["USER_REQUEST"]);
});
