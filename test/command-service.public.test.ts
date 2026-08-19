import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TranslationCommandService,
  type StartCommandInput,
} from "../src/commands/translation-command-service.js";
import { ApplicationError } from "../src/domain/application-error.js";
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
  reconciliation: { calls: number };
};

class RecordingUsageGate implements UsageGate {
  public calls = 0;
  public readonly inputs: { guildId: string; userIds: readonly string[] }[] = [];
  public error: ApplicationError | undefined;
  public wait: Promise<void> = Promise.resolve();

  public async assertCanStart(
    input: Parameters<UsageGate["assertCanStart"]>[0],
  ): Promise<void> {
    this.calls += 1;
    this.inputs.push({ guildId: input.guildId, userIds: [...input.userIds] });
    await this.wait;
    if (this.error) throw this.error;
  }
}

class RecordingCapacityGate implements CapacityGate {
  public calls = 0;
  public readonly inputs: { sttStreams: number; ttsStreams: number }[] = [];
  public wait: Promise<void> = Promise.resolve();

  public async assertCanStart(
    input: Parameters<CapacityGate["assertCanStart"]>[0],
  ): Promise<void> {
    this.calls += 1;
    this.inputs.push({ sttStreams: input.sttStreams, ttsStreams: input.ttsStreams });
    await this.wait;
  }
}

class RecordingRuntime implements SessionRuntime {
  public readonly updates: string[][] = [];
  public readonly stopReasons: string[] = [];
  public stopError: Error | undefined;
  public readonly playbackModes: string[] = [];
  public readonly audioStates: boolean[] = [];
  public readonly captionFailurePolicies: string[] = [];

  public updateParticipants(participantIds: readonly string[]): Promise<void> {
    this.updates.push([...participantIds]);
    return Promise.resolve();
  }

  public stop(reason: string): Promise<void> {
    this.stopReasons.push(reason);
    return this.stopError ? Promise.reject(this.stopError) : Promise.resolve();
  }

  public setPlaybackMode(mode: "conversation" | "accuracy"): Promise<void> {
    this.playbackModes.push(mode);
    return Promise.resolve();
  }

  public setAudioEnabled(enabled: boolean): Promise<void> {
    this.audioStates.push(enabled);
    return Promise.resolve();
  }

  public setCaptionFailurePolicy(
    policy: "continue_audio" | "stop_session",
  ): Promise<void> {
    this.captionFailurePolicies.push(policy);
    return Promise.resolve();
  }
}

class RecordingDriver implements TranslationSessionDriver {
  public readonly starts: { guildId: string; participantIds: readonly string[] }[] = [];
  public readonly runtimes: RecordingRuntime[] = [];
  public readonly signals: AbortSignal[] = [];
  public wait: Promise<void> = Promise.resolve();

  public async start(
    session: { guildId: string },
    participantIds: readonly string[],
    signal: AbortSignal,
  ): Promise<SessionRuntime> {
    this.starts.push({ guildId: session.guildId, participantIds: [...participantIds] });
    this.signals.push(signal);
    await this.wait;
    const runtime = new RecordingRuntime();
    this.runtimes.push(runtime);
    return runtime;
  }
}

function createHarness(options: {
  allowedUserIds?: readonly string[];
  maxSpeakersPerSession?: number;
} = {}): Harness {
  const driver = new RecordingDriver();
  const usageGate = new RecordingUsageGate();
  const capacityGate = new RecordingCapacityGate();
  const reconciliation = { calls: 0 };
  const sessions = new SessionManager({
    driver,
    usageGate,
    capacityGate,
    onSessionStopped: () => {
      reconciliation.calls += 1;
      return Promise.resolve();
    },
    now: () => new Date("2026-08-15T03:00:00Z"),
    createId: () => "00000000-0000-4000-8000-000000000001",
  });
  const service = new TranslationCommandService({
    allowedGuildIds: new Set(["223456789012345678"]),
    allowedUserIds: new Set(options.allowedUserIds ?? [
      "323456789012345678",
      "423456789012345678",
    ]),
    maxSpeakersPerSession: options.maxSpeakersPerSession ?? 2,
    sessions,
  });
  return { service, driver, usageGate, capacityGate, reconciliation };
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
      text: {
        viewChannel: true,
        sendMessages: true,
        createPublicThreads: true,
        sendMessagesInThreads: true,
        manageThreads: true,
      },
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
        text: {
          viewChannel: true,
          sendMessages: false,
          createPublicThreads: true,
          sendMessagesInThreads: true,
          manageThreads: true,
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "BOT_PERMISSION_MISSING");
  assert.match(result.interactionMessage, /Connect/);
  assert.match(result.interactionMessage, /SendMessages/);
  assert.equal(harness.driver.starts.length, 0);
});

void test("専用スレッドの作成・送信・終了時アーカイブ権限を開始前に確認する", async () => {
  const harness = createHarness();
  const result = await harness.service.execute(validStart({
    botPermissions: {
      voice: { viewChannel: true, connect: true, speak: true },
      text: {
        viewChannel: true,
        sendMessages: true,
        createPublicThreads: false,
        sendMessagesInThreads: false,
        manageThreads: false,
      },
    },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, "BOT_PERMISSION_MISSING");
  assert.match(result.interactionMessage, /CreatePublicThreads/u);
  assert.match(result.interactionMessage, /SendMessagesInThreads/u);
  assert.match(result.interactionMessage, /ManageThreads/u);
  assert.equal(harness.driver.starts.length, 0);
});

void test("許可条件を満たすと利用量・容量を確認して1セッションだけ開始する", async () => {
  const harness = createHarness();

  const result = await harness.service.execute(validStart());

  assert.equal(result.ok, true);
  assert.equal(result.ephemeral, true);
  assert.equal(result.publicMessage, undefined);
  assert.match(result.interactionMessage, /専用スレッド/u);
  assert.equal(harness.service.getSession("223456789012345678")?.playbackMode, "conversation");
  assert.equal(harness.service.getSession("223456789012345678")?.audioEnabled, true);
  assert.equal(
    harness.service.getSession("223456789012345678")?.captionFailurePolicy,
    "continue_audio",
  );
  assert.equal(harness.usageGate.calls, 1);
  assert.equal(harness.capacityGate.calls, 1);
  assert.equal(harness.driver.starts.length, 1);
});

void test("上限3人なら許可済み3人で開始し、STT 3本分の容量を確認する", async () => {
  const participantIds = [
    "323456789012345678",
    "423456789012345678",
    "523456789012345678",
  ];
  const fourthUserId = "623456789012345678";
  const harness = createHarness({
    allowedUserIds: [...participantIds, fourthUserId],
    maxSpeakersPerSession: 3,
  });

  const result = await harness.service.execute(validStart({
    voiceChannel: {
      id: "623456789012345678",
      name: "General",
      humanParticipantIds: participantIds,
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.capacityGate.inputs, [{ sttStreams: 3, ttsStreams: 1 }]);
  assert.deepEqual(harness.driver.starts[0]?.participantIds, participantIds);

  const exceeded = await harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    [...participantIds, fourthUserId],
  );
  assert.deepEqual(exceeded, { stopped: true, reason: "TOO_MANY_SPEAKERS" });
  assert.deepEqual(harness.driver.runtimes[0]?.stopReasons, ["TOO_MANY_SPEAKERS"]);
});

void test("上限3人なら実行中に許可済みの3人目を追加する", async () => {
  const participantIds = [
    "323456789012345678",
    "423456789012345678",
    "523456789012345678",
  ];
  const harness = createHarness({
    allowedUserIds: participantIds,
    maxSpeakersPerSession: 3,
  });
  assert.equal((await harness.service.execute(validStart())).ok, true);

  const result = await harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    participantIds,
  );

  assert.deepEqual(result, { stopped: false });
  assert.deepEqual(harness.driver.runtimes[0]?.updates, [participantIds]);
  assert.deepEqual(harness.usageGate.inputs[1]?.userIds, ["523456789012345678"]);
});

void test("利用上限へ到達済みの3人目はruntimeへ追加せずセッションを停止する", async () => {
  const participantIds = [
    "323456789012345678",
    "423456789012345678",
    "523456789012345678",
  ];
  const harness = createHarness({
    allowedUserIds: participantIds,
    maxSpeakersPerSession: 3,
  });
  assert.equal((await harness.service.execute(validStart())).ok, true);
  harness.usageGate.error = new ApplicationError(
    "USAGE_LIMIT_REACHED",
    "userの月間利用上限へ達しています。翌月または上限変更後に再実行してください。",
  );

  const result = await harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    participantIds,
  );
  const runtime = harness.driver.runtimes[0];
  assert.ok(runtime);

  assert.deepEqual(result, { stopped: true, reason: "USAGE_LIMIT_REACHED" });
  assert.deepEqual(runtime.updates, []);
  assert.deepEqual(runtime.stopReasons, ["USAGE_LIMIT_REACHED"]);
});

void test("3人目の利用量確認中に退出しても古い参加者状態へ戻さない", async () => {
  const participantIds = [
    "323456789012345678",
    "423456789012345678",
    "523456789012345678",
  ];
  const harness = createHarness({
    allowedUserIds: participantIds,
    maxSpeakersPerSession: 3,
  });
  assert.equal((await harness.service.execute(validStart())).ok, true);
  let releaseUsageCheck: (() => void) | undefined;
  harness.usageGate.wait = new Promise<void>((resolve) => {
    releaseUsageCheck = resolve;
  });

  const adding = harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    participantIds,
  );
  while (harness.usageGate.inputs.length < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const removing = await harness.service.handleVoiceParticipantsChanged(
    "223456789012345678",
    participantIds.slice(0, 2),
  );
  releaseUsageCheck?.();

  assert.deepEqual(removing, { stopped: false });
  assert.deepEqual(await adding, { stopped: false });
  assert.deepEqual(harness.driver.runtimes[0]?.updates, [participantIds.slice(0, 2)]);
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

void test("CONNECTING中に停止されたstartは、遅れて作成されたruntimeも必ず破棄する", async () => {
  const harness = createHarness();
  let releaseDriver: (() => void) | undefined;
  harness.driver.wait = new Promise<void>((resolve) => {
    releaseDriver = resolve;
  });

  const starting = harness.service.execute(validStart());
  while (harness.driver.starts.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const stopped = await harness.service.execute({
    kind: "stop",
    guildId: "223456789012345678",
    actorId: "323456789012345678",
    actorCanManageGuild: false,
    actorVoiceChannelId: "523456789012345678",
  });
  assert.equal(stopped.ok, true);
  assert.equal(harness.driver.signals[0]?.aborted, true);

  const immediateRestart = harness.service.execute(validStart());
  const immediateRestartResult = await Promise.race([
    immediateRestart,
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.notEqual(immediateRestartResult, "pending");
  assert.equal(
    immediateRestartResult === "pending" ? undefined : immediateRestartResult.ok,
    false,
  );
  assert.equal(
    immediateRestartResult === "pending" || immediateRestartResult.ok
      ? undefined
      : immediateRestartResult.code,
    "SESSION_ALREADY_ACTIVE",
  );

  releaseDriver?.();
  const startResult = await starting;
  assert.equal(startResult.ok, false);
  assert.equal(startResult.code, "SESSION_START_FAILED");
  assert.deepEqual(harness.driver.runtimes[0]?.stopReasons, ["START_ABORTED"]);

  const restarted = await harness.service.execute(validStart());
  assert.equal(restarted.ok, true);
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
  assert.equal(stopped.publicMessage, undefined);
  assert.deepEqual(harness.driver.runtimes[0]?.stopReasons, ["USER_REQUEST"]);
  assert.equal(harness.reconciliation.calls, 1);
});

void test("実行中のカード操作は同じ停止認可を使い、設定と字幕のみをセッションへ反映する", async () => {
  const harness = createHarness();
  assert.equal((await harness.service.execute(validStart({ mode: "accuracy" }))).ok, true);
  const session = harness.service.getSession("223456789012345678");
  assert.ok(session);
  assert.equal(session.playbackMode, "accuracy");

  const common = {
    kind: "control" as const,
    guildId: session.guildId,
    sessionId: session.sessionId,
    actorId: "423456789012345678",
    actorCanManageGuild: false,
    actorVoiceChannelId: session.voiceChannelId,
  };
  assert.equal((await harness.service.execute({
    ...common,
    action: "toggle_audio",
  })).ok, true);
  assert.equal((await harness.service.execute({
    ...common,
    action: "set_playback_mode",
    value: "conversation",
  })).ok, true);
  assert.equal((await harness.service.execute({
    ...common,
    action: "set_caption_failure_policy",
    value: "stop_session",
  })).ok, true);

  const runtime = harness.driver.runtimes[0];
  assert.ok(runtime);
  assert.deepEqual(runtime.audioStates, [false]);
  assert.deepEqual(runtime.playbackModes, ["conversation"]);
  assert.deepEqual(runtime.captionFailurePolicies, ["stop_session"]);
  assert.equal(session.audioEnabled, false);
  assert.equal(session.playbackMode, "conversation");
  assert.equal(session.captionFailurePolicy, "stop_session");

  const stale = await harness.service.execute({
    ...common,
    sessionId: "old-session",
    action: "toggle_audio",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "SESSION_NOT_ACTIVE");
});

void test("runtimeの停止処理が失敗しても停止後の利用ログ照合を実行する", async () => {
  const harness = createHarness();
  assert.equal((await harness.service.execute(validStart())).ok, true);
  const runtime = harness.driver.runtimes[0];
  assert.ok(runtime);
  runtime.stopError = new Error("cleanup failed");

  await assert.rejects(
    harness.service.stopForFailure("223456789012345678", "VOICE_CONNECTION_LOST"),
    AggregateError,
  );

  assert.equal(harness.reconciliation.calls, 1);
});
