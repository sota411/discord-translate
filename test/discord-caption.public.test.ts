import assert from "node:assert/strict";
import { test } from "node:test";

import { ComponentType, MessageFlags, REST } from "discord.js";

import {
  DiscordCaptionGateway,
  type CaptionDeliveryObservation,
  type CaptionMessagePayload,
} from "../src/discord/caption-gateway.js";
import { ApplicationError } from "../src/domain/application-error.js";

type SerializedComponent = {
  type: ComponentType;
  content?: string;
  components?: SerializedComponent[];
};

function textContents(payload: CaptionMessagePayload): string[] {
  const components = (payload as unknown as {
    components?: { toJSON(): SerializedComponent }[];
  }).components ?? [];
  const visit = (component: SerializedComponent): string[] => [
    ...(component.type === ComponentType.TextDisplay && component.content
      ? [component.content]
      : []),
    ...(component.components?.flatMap(visit) ?? []),
  ];
  return components.flatMap((component) => visit(component.toJSON()));
}

void test("字幕の作成と編集の両方でmentionを無効化し、同じメッセージだけを更新する", async () => {
  const sent: CaptionMessagePayload[] = [];
  const edited: CaptionMessagePayload[] = [];
  const channel = {
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({
        edit(next: CaptionMessagePayload) {
          edited.push(next);
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      });
    },
  };
  const captions = new DiscordCaptionGateway(channel);

  const reference = await captions.post({
    utteranceId: "u1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "@everyone **sota**",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "**今日**VALORANTやる？",
    translatedText: "오늘 VALORANT 할래?",
    sourceDurationMs: 500,
    state: "pending",
  });
  assert.ok(reference !== undefined);
  await captions.update(reference, "played");

  assert.deepEqual(sent[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(edited[0]?.allowedMentions, { parse: [] });
  assert.equal(
    (sent[0] as unknown as { flags?: number }).flags,
    MessageFlags.IsComponentsV2,
  );
  assert.equal(
    (edited[0] as unknown as { flags?: number }).flags,
    MessageFlags.IsComponentsV2,
  );
  assert.equal("content" in sent[0], false);
  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(textContents(message), [
    "**@everyone \\*\\*sota\\*\\*** · `JA → KO`",
    "**JA**\n\\*\\*今日\\*\\*VALORANTやる？",
    "**KO**\n오늘 VALORANT 할래?",
    "-# ⏳ 再生待ち",
  ]);
  assert.deepEqual(textContents(edited[0]), [
    "**@everyone \\*\\*sota\\*\\*** · `JA → KO`",
    "**JA**\n\\*\\*今日\\*\\*VALORANTやる？",
    "**KO**\n오늘 VALORANT 할래?",
    "-# 🔊 再生済み",
  ]);
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
});

void test("仮字幕を同じメッセージへ間引き更新し、確定時にもその1件を置き換える", async () => {
  const sent: CaptionMessagePayload[] = [];
  const edited: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({
        edit(next: CaptionMessagePayload) {
          edited.push(next);
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      });
    },
  });

  await captions.preview({
    utteranceId: "turn-1",
    speakerDisplayName: "Sota",
    originalText: "明日の夜って空い…",
    translatedText: "내일 저녁에…",
  });
  await captions.preview({
    utteranceId: "turn-1",
    speakerDisplayName: "Sota",
    originalText: "明日の夜って空いてる？",
    translatedText: "내일 저녁에 시간 있어?",
  });
  await captions.preview({
    utteranceId: "turn-1",
    speakerDisplayName: "Sota",
    originalText: "明日の夜って空いてる？",
    translatedText: "내일 저녁에 시간 있어?",
  });
  const reference = await captions.post({
    utteranceId: "turn-1",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "明日の夜って空いてる？",
    translatedText: "내일 저녁에 시간 있어?",
    sourceDurationMs: 800,
    state: "pending",
  });

  assert.equal(sent.length, 1);
  assert.equal(edited.length, 2);
  const interimMessage = sent[0];
  const updatedInterimMessage = edited[0];
  const finalMessage = edited[1];
  assert.ok(interimMessage);
  assert.ok(updatedInterimMessage);
  assert.ok(finalMessage);
  assert.deepEqual(textContents(interimMessage), [
    "**Sota**",
    "認識中: 明日の夜って空い…\n翻訳中: 내일 저녁에…",
  ]);
  assert.match(textContents(updatedInterimMessage).join("\n"), /空いてる/u);
  assert.match(textContents(finalMessage).join("\n"), /再生待ち/u);
  assert.equal(reference, 1);
});

for (const speakerCount of [1, 3]) {
  void test(`${String(speakerCount)}人の長い発話をDiscordの残り枠で配分し、同じメッセージへ更新を続ける`, async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const channelId = "111111111111111111";
    const route = `/channels/${channelId}/messages` as const;
    const requests: { at: number; method: string; body: string }[] = [];
    let resetAt = 0;
    let remaining = 0;
    let rateLimited = 0;
    // Discordの固定仕様ではなく、5秒に5回という応答を返すテスト条件。
    const rest = new REST({
      offset: 0,
      makeRequest: (_url, options) => {
        assert.ok(typeof options.body === "string");
        requests.push({ at: Date.now(), method: options.method ?? "GET", body: options.body });
        const headers = new Headers({ "Content-Type": "application/json" });
        let status = 200;
        if (options.method === "PATCH") {
          if (Date.now() >= resetAt) {
            resetAt = Date.now() + 5_000;
            remaining = 5;
          }
          if (remaining > 0) {
            remaining -= 1;
          } else {
            status = 429;
            rateLimited += 1;
            headers.set("Retry-After", String((resetAt - Date.now()) / 1_000));
          }
          headers.set("X-RateLimit-Bucket", "caption-test");
          headers.set("X-RateLimit-Limit", "5");
          headers.set("X-RateLimit-Remaining", String(remaining));
          headers.set("X-RateLimit-Reset-After", String((resetAt - Date.now()) / 1_000));
        }
        return Promise.resolve({
          status, statusText: "test", ok: status === 200, headers, body: null, bodyUsed: false,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      },
    }).setToken("caption-test-token");
    let messageId = 222222222222222222n;
    const captions = new DiscordCaptionGateway({
      async send(payload) {
        await rest.post(route, { body: payload });
        const messageRoute = `${route}/${String(messageId++)}` as const;
        return {
          edit: (next) => rest.patch(messageRoute, { body: next }),
          delete: () => rest.delete(messageRoute),
        };
      },
    }, { rateLimits: { rest, channelId } });
    context.after(() => {
      void captions.close();
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
    });
    const preview = (index: number, speaker = 0) => captions.preview({
      utteranceId: `long-turn-${String(speaker)}`,
      speakerDisplayName: `話者${String(speaker)}`,
      originalText: `長い発話の途中${String(index)}`,
      translatedText: "인식 중",
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    for (let speaker = 0; speaker < speakerCount; speaker += 1) await preview(0, speaker);
    context.mock.timers.tick(500);
    await preview(1);
    for (let index = 2; index <= 40; index += 1) {
      context.mock.timers.tick(500);
      for (let speaker = 0; speaker < speakerCount; speaker += 1) void preview(index, speaker);
      await flush();
      if (index === 2) assert.equal(requests.length, speakerCount + 1, "残り枠に合わせて編集を待つ");
    }
    assert.equal(rateLimited, 0);
    const edits = requests.filter((request) => request.method === "PATCH");
    assert.ok(edits.length >= 10 && edits.length < 20);
    for (let speaker = 0; speaker < speakerCount; speaker += 1) {
      const speakerEdits = edits.filter((edit) => edit.body.includes(`話者${String(speaker)}`));
      assert.ok(speakerEdits.length >= 3);
      let previous: (typeof speakerEdits)[number] | undefined;
      for (const edit of speakerEdits) {
        if (previous) {
          assert.ok(edit.at - previous.at <= 2_000 * speakerCount, "全話者の後半も継続的に更新する");
        }
        previous = edit;
      }
      assert.ok(previous);
      const match = /長い発話の途中(\d+)/u.exec(previous.body);
      assert.ok(match?.[1]);
      const latest = Number(match[1]);
      assert.ok(latest >= 40 - 4 * speakerCount, "古い更新を溜めず最新の途中字幕へ追いつく");
    }
    context.diagnostic(`20秒間・${String(speakerCount)}人: 途中編集${String(edits.length)}回、429応答${String(rateLimited)}回`);

    const final = captions.post({
      utteranceId: "long-turn-0", sessionId: "s1", speakerUserId: "user1",
      speakerDisplayName: "話者0", voiceId: "speaker-test-voice",
      sourceLanguage: "ja", targetLanguage: "ko",
      originalText: "長い発話の確定結果", translatedText: "확정 결과",
      sourceDurationMs: 20_000, state: "captions_only",
    });
    await flush();
    const finalRequest = requests.at(-1);
    assert.ok(finalRequest);
    assert.equal(finalRequest.at, Date.now(), "確定字幕は仮字幕の待機を追い越す");
    assert.match(finalRequest.body, /長い発話の確定結果/u);
    assert.equal(await final, 1);
    assert.equal(rateLimited, 0);
    assert.equal(requests.filter((request) => request.method === "POST").length, speakerCount);
    const completedCount = requests.length;
    if (speakerCount > 1) await captions.close();
    context.mock.timers.tick(10_000);
    await flush();
    assert.equal(requests.length, completedCount, "確定・停止後は待機中の仮字幕を送らない");
    await captions.close();
    assert.equal(rest.listenerCount("response"), 0);
    assert.equal(rest.listenerCount("rateLimited"), 0);
  });
}

for (const [headerState, rateLimitHeaders] of [
  ["RemainingとReset-Afterが空の", {
    "X-RateLimit-Bucket": "caption-test",
    "X-RateLimit-Remaining": "",
    "X-RateLimit-Reset-After": "",
  }],
  ["RemainingとReset-Afterが欠損した", { "X-RateLimit-Bucket": "caption-test" }],
  ["Bucketが空の", {
    "X-RateLimit-Bucket": " ",
    "X-RateLimit-Remaining": "1",
    "X-RateLimit-Reset-After": "1",
  }],
  ["Bucketが欠損した", {
    "X-RateLimit-Remaining": "1",
    "X-RateLimit-Reset-After": "1",
  }],
] as const) void test(`${headerState}Discordレート制限ヘッダーを拒否して編集を保留する`, async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const channelId = "111111111111111111";
  const route = `/channels/${channelId}/messages` as const;
  const warnings: string[] = [];
  let requests = 0;
  let recovered = false;
  const rest = new REST({
    offset: 0,
    makeRequest: () => {
      requests += 1;
      const headers = new Headers({
        "Content-Type": "application/json",
        ...(recovered ? {
          "X-RateLimit-Bucket": "caption-test",
          "X-RateLimit-Remaining": "1",
          "X-RateLimit-Reset-After": "1",
        } : rateLimitHeaders),
      });
      return Promise.resolve({
        status: 200, statusText: "test", ok: true, headers, body: null, bodyUsed: false,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    },
  }).setToken("caption-test-token");
  const captions = new DiscordCaptionGateway({
    async send(payload) {
      await rest.post(route, { body: payload });
      return {
        edit: (next) => rest.patch(`${route}/222222222222222222`, { body: next }),
        delete: () => rest.delete(`${route}/222222222222222222`),
      };
    },
  }, {
    rateLimits: { rest, channelId },
    onWarning: (operation) => warnings.push(operation),
  });

  try {
    await captions.preview({
      utteranceId: "blank-header-turn", speakerDisplayName: "Sota",
      originalText: "最初", translatedText: "처음",
    });
    await captions.preview({
      utteranceId: "blank-header-turn", speakerDisplayName: "Sota",
      originalText: "更新", translatedText: "갱신",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, ["caption_preview"]);

    const delayed = captions.preview({
      utteranceId: "blank-header-turn", speakerDisplayName: "Sota",
      originalText: "さらに更新", translatedText: "다시 갱신",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    context.mock.timers.tick(10_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    recovered = true;
    await rest.patch(`${route}/333333333333333333`, { body: {} });
    assert.equal(requests, 3);
    context.mock.timers.tick(1_000);
    await delayed;
    assert.equal(requests, 4);
  } finally {
    await captions.close();
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  }
});

void test("他スレッドの制限は混ぜず、全体制限中は最新字幕を保持して破棄時に待機を解除する", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const rest = new REST();
  const edits: CaptionMessagePayload[] = [];
  let deleted = 0;
  const captions = new DiscordCaptionGateway({
    send: () => Promise.resolve({
      edit: (payload) => {
        edits.push(payload);
        return Promise.resolve();
      },
      delete: () => { deleted += 1; return Promise.resolve(); },
    }),
  }, { rateLimits: { rest, channelId: "caption-thread" } });
  context.after(() => {
    void captions.close();
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  });
  const preview = (text: string) => captions.preview({
    utteranceId: "turn", speakerDisplayName: "Sota", originalText: text, translatedText: "",
  });
  const limit = {
    global: false, hash: "test", limit: 5, majorParameter: "other-thread",
    method: "PATCH", route: "/channels/:id/messages/:id", url: "https://example.invalid/",
    retryAfter: 2_000, sublimitTimeout: 0, timeToReset: 2_000, scope: "user" as const,
  };
  await preview("最初");
  rest.emit("rateLimited", limit);
  await preview("他スレッドの制限中も更新");
  assert.equal(edits.length, 1);

  rest.emit("rateLimited", {
    ...limit, hash: "post", majorParameter: "caption-thread",
    method: "POST", route: "/channels/:id/messages",
  });
  const afterPostLimit = preview("同じスレッドの別POST枠でも更新");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(edits.length, 2);
  await afterPostLimit;

  rest.emit("rateLimited", {
    ...limit, hash: "reaction", majorParameter: "caption-thread",
    method: "PUT", route: "/channels/:id/messages/:id/reactions/:emoji/@me",
  });
  const afterReactionLimit = preview("同じスレッドのリアクション枠でも更新");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(edits.length, 3);
  await afterReactionLimit;

  rest.emit("rateLimited", { ...limit, global: true });
  const old = preview("古い途中字幕");
  const latest = preview("最新の途中字幕");
  await old;
  context.mock.timers.tick(1_999);
  assert.equal(edits.length, 3);
  context.mock.timers.tick(1);
  await latest;
  const latestEdit = edits[3];
  assert.ok(latestEdit);
  assert.match(textContents(latestEdit).join("\n"), /最新の途中字幕/u);

  rest.emit("rateLimited", { ...limit, majorParameter: "caption-thread" });
  const discarded = preview("破棄する途中字幕");
  await captions.discardPreview("turn");
  await discarded;
  context.mock.timers.tick(2_000);
  assert.equal(deleted, 1);
  assert.equal(edits.length, 4);
});

void test("遅い仮字幕は実行中1件と最新1件だけにまとめ、確定字幕を優先する", async () => {
  let finishFirstSend: ((message: {
    edit(payload: CaptionMessagePayload): Promise<void>;
    delete(): Promise<void>;
  }) => void) | undefined;
  const edits: CaptionMessagePayload[] = [];
  const observations: CaptionDeliveryObservation[] = [];
  let sendCount = 0;
  const captions = new DiscordCaptionGateway({
    send() {
      sendCount += 1;
      return new Promise((resolve) => {
        finishFirstSend = resolve;
      });
    },
  }, {
    observeDelivery: (observation) => observations.push(observation),
  });

  const first = captions.preview({
    utteranceId: "turn-bounded",
    speakerDisplayName: "Sota",
    originalText: "一つ目",
    translatedText: "첫 번째",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = captions.preview({
    utteranceId: "turn-bounded",
    speakerDisplayName: "Sota",
    originalText: "二つ目",
    translatedText: "두 번째",
  });
  const third = captions.preview({
    utteranceId: "turn-bounded",
    speakerDisplayName: "Sota",
    originalText: "三つ目",
    translatedText: "세 번째",
  });
  const final = captions.post({
    utteranceId: "turn-bounded",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "確定",
    translatedText: "확정",
    sourceDurationMs: 800,
    state: "pending",
  });

  const pendingReleased = await Promise.race([
    Promise.all([second, third]).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  assert.equal(sendCount, 1);
  assert.equal(edits.length, 0);
  finishFirstSend?.({
    edit(payload) {
      edits.push(payload);
      return Promise.resolve();
    },
    delete: () => Promise.resolve(),
  });
  await first;
  assert.equal(await final, 1);

  assert.equal(pendingReleased, true);
  assert.equal(edits.length, 1);
  const finalEdit = edits[0];
  assert.ok(finalEdit);
  assert.match(textContents(finalEdit).join("\n"), /確定/u);
  assert.doesNotMatch(textContents(finalEdit).join("\n"), /三つ目/u);
  assert.equal(observations.length, 1);
  assert.deepEqual(
    {
      ...observations[0],
      final_wait_ms: 0,
      final_delivery_ms: 0,
    },
    {
      trace_id: "turn-bounded",
      outcome: "posted",
      succeeded: true,
      preview_requested: 3,
      preview_sent: 1,
      preview_coalesced: 2,
      final_wait_ms: 0,
      final_delivery_ms: 0,
    },
  );
});

void test("異なる発話の仮字幕は互いの遅いREST操作を待たない", async () => {
  const finishes: (() => void)[] = [];
  let sendCount = 0;
  const captions = new DiscordCaptionGateway({
    send() {
      sendCount += 1;
      return new Promise((resolve) => {
        finishes.push(() => resolve({
          edit: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        }));
      });
    },
  });

  const first = captions.preview({
    utteranceId: "speaker-a-turn",
    speakerDisplayName: "A",
    originalText: "一つ目",
    translatedText: "첫 번째",
  });
  const second = captions.preview({
    utteranceId: "speaker-b-turn",
    speakerDisplayName: "B",
    originalText: "二つ目",
    translatedText: "두 번째",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sendCount, 2);
  for (const finish of finishes) finish();
  await Promise.all([first, second]);
});

void test("確定結果がない発話の仮字幕を破棄する", async () => {
  let deleted = 0;
  const captions = new DiscordCaptionGateway({
    send() {
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => {
          deleted += 1;
          return Promise.resolve();
        },
      });
    },
  });

  await captions.preview({
    utteranceId: "turn-empty-endpoint",
    speakerDisplayName: "Sota",
    originalText: "聞き取れ…",
    translatedText: "",
  });
  await captions.discardPreview("turn-empty-endpoint");

  assert.equal(deleted, 1);
});

void test("仮字幕の削除失敗は警告だけで翻訳を継続する", async () => {
  const warnings: string[] = [];
  const observations: CaptionDeliveryObservation[] = [];
  const captions = new DiscordCaptionGateway({
    send() {
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.reject(new Error("delete failed")),
      });
    },
  }, {
    failurePolicy: "stop_session",
    onWarning: (operation) => warnings.push(operation),
    observeDelivery: (observation) => observations.push(observation),
  });

  await captions.preview({
    utteranceId: "turn-delete-failure",
    speakerDisplayName: "Sota",
    originalText: "聞き取れ…",
    translatedText: "",
  });
  await captions.discardPreview("turn-delete-failure");

  assert.deepEqual(warnings, ["caption_update"]);
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.ok(observation);
  assert.equal(observation.outcome, "discarded");
  assert.equal(observation.succeeded, false);
});

void test("厳格設定でも既存仮字幕のfinal上限超過は警告だけで継続する", async () => {
  let sendCount = 0;
  let deleted = 0;
  const warnings: string[] = [];
  const captions = new DiscordCaptionGateway({
    send() {
      sendCount += 1;
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => {
          deleted += 1;
          return Promise.resolve();
        },
      });
    },
  }, {
    failurePolicy: "stop_session",
    onWarning: (operation) => warnings.push(operation),
  });

  await captions.preview({
    utteranceId: "turn-final-too-long",
    speakerDisplayName: "Sota",
    originalText: "認識中",
    translatedText: "인식 중",
  });
  const reference = await captions.post({
    utteranceId: "turn-final-too-long",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "あ".repeat(4_000),
    translatedText: "가",
    sourceDurationMs: 800,
    state: "pending",
  });

  assert.equal(reference, undefined);
  assert.equal(sendCount, 1);
  assert.equal(deleted, 1);
  assert.deepEqual(warnings, ["caption_update"]);
});

void test("仮字幕の確定編集に失敗したら古い表示を削除して確定字幕を投稿し直す", async () => {
  let sendCount = 0;
  let deleteCount = 0;
  const warnings: string[] = [];
  const sent: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload) {
      sendCount += 1;
      sent.push(payload);
      return Promise.resolve({
        edit() {
          return Promise.reject(new Error("final edit failed"));
        },
        delete() {
          deleteCount += 1;
          return Promise.resolve();
        },
      });
    },
  }, {
    onWarning: (operation) => warnings.push(operation),
  });

  await captions.preview({
    utteranceId: "turn-edit-failure",
    speakerDisplayName: "Sota",
    originalText: "明日の夜って空い…",
    translatedText: "내일 저녁에…",
  });
  const reference = await captions.post({
    utteranceId: "turn-edit-failure",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "明日の夜って空いてる？",
    translatedText: "내일 저녁에 시간 있어?",
    sourceDurationMs: 800,
    state: "pending",
  });

  assert.equal(reference, 1);
  assert.equal(sendCount, 2);
  assert.equal(deleteCount, 1);
  assert.deepEqual(warnings, ["caption_update"]);
  const finalPayload = sent[1];
  assert.ok(finalPayload);
  assert.match(textContents(finalPayload).join("\n"), /明日の夜って空いてる/u);
  assert.doesNotMatch(textContents(finalPayload).join("\n"), /明日の夜って空い…/u);
});

void test("字幕の送信・状態編集が失敗しても既定では警告だけで音声処理を継続できる", async () => {
  const warnings: string[] = [];
  let editFails = false;
  const captions = new DiscordCaptionGateway({
    send() {
      if (warnings.length === 0) return Promise.reject(new Error("send failed"));
      return Promise.resolve({
        edit() {
          return editFails
            ? Promise.reject(new Error("edit failed"))
            : Promise.resolve();
        },
        delete: () => Promise.resolve(),
      });
    },
  }, {
    onWarning: (operation) => warnings.push(operation),
  });
  const utterance = {
    utteranceId: "u-warning",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja" as const,
    targetLanguage: "ko" as const,
    originalText: "こんにちは",
    translatedText: "안녕하세요",
    sourceDurationMs: 500,
    state: "pending" as const,
  };

  assert.equal(await captions.post(utterance), undefined);
  const reference = await captions.post(utterance);
  assert.equal(reference, 1);
  editFails = true;
  await captions.update(reference, "played");
  await captions.update(reference, "played");
  assert.deepEqual(warnings, ["caption_post", "caption_update"]);
});

void test("字幕エラー時に停止する設定では、初回字幕の最終失敗だけを致命エラーへ変換する", async () => {
  const captions = new DiscordCaptionGateway({
    send() {
      return Promise.reject(new Error("send failed"));
    },
  }, {
    failurePolicy: "stop_session",
  });

  await assert.rejects(
    captions.preview({
      utteranceId: "u-strict-preview",
      speakerDisplayName: "Sota",
      originalText: "認識中",
      translatedText: "인식 중",
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "CAPTION_SEND_FAILED",
  );
  await assert.rejects(
    captions.post({
      utteranceId: "u-strict-caption",
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "Sota",
      voiceId: "speaker-test-voice",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: "こんにちは",
      translatedText: "안녕하세요",
      sourceDurationMs: 500,
      state: "pending",
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "CAPTION_SEND_FAILED",
  );
});

void test("停止時は未完了の字幕送信を待たず、遅い完了後も状態を復活させない", async () => {
  let finishSend: ((message: {
    edit(): Promise<void>;
    delete(): Promise<void>;
  }) => void) | undefined;
  const captions = new DiscordCaptionGateway({
    send() {
      return new Promise<{
        edit(): Promise<void>;
        delete(): Promise<void>;
      }>((resolve) => {
        finishSend = resolve;
      });
    },
  });
  const post = captions.post({
    utteranceId: "u-close-with-pending-send",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "Sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "停止します",
    translatedText: "중지합니다",
    sourceDurationMs: 500,
    state: "pending",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const closeResult = await Promise.race([
    captions.close().then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  const postResult = await Promise.race([
    post.then((reference) => ({ settled: true as const, reference })),
    new Promise<{ settled: false }>((resolve) => {
      setTimeout(() => resolve({ settled: false }), 20);
    }),
  ]);
  assert.deepEqual(postResult, { settled: true, reference: undefined });
  finishSend?.({
    edit: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(closeResult, "closed");
});

void test("字幕の未再生と中断状態を短い言語非依存ラベルで表示する", async () => {
  const states = [
    ["not_played", "-# ⚠ 音声未再生"],
    ["partial_failure", "-# ⚠ 音声中断"],
    ["skipped_delay", "-# ⏭ 遅延回避のため音声省略"],
    ["interrupted_for_conversation", "-# ⏭ 新しい発話のため音声中断"],
    ["captions_only", "-# 📝 字幕のみ"],
  ] as const;

  for (const [state, expected] of states) {
    const sent: CaptionMessagePayload[] = [];
    const captions = new DiscordCaptionGateway({
      send(payload: CaptionMessagePayload) {
        sent.push(payload);
        return Promise.resolve({
          edit: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        });
      },
    });

    await captions.post({
      utteranceId: `u-${state}`,
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
      sourceLanguage: "en",
      targetLanguage: "ja",
      originalText: "hello",
      translatedText: "こんにちは",
      sourceDurationMs: 500,
      state,
    });

    const message = sent[0];
    assert.ok(message);
    assert.equal(textContents(message).at(-1), expected);
  }
});

void test("字幕本文をDiscord Markdownとして解釈させず文字列のまま表示する", async () => {
  const sent: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      });
    },
  });

  await captions.post({
    utteranceId: "u-markdown",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "# speaker",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "# heading\n- item\n1. item\n> quote\n[label](https://example.com)\n<https://example.com>\n<@123456789012345678>\n<t:0:R>",
    translatedText: "**bold**",
    sourceDurationMs: 500,
    state: "pending",
  });

  const message = sent[0];
  assert.ok(message);
  assert.deepEqual(textContents(message), [
    "**\\# speaker** · `JA → KO`",
    "**JA**\n\\# heading\n\\- item\n1\\. item\n\\> quote\n\\[label](https://example.com)\n\\<https://example.com\\>\n\\<@123456789012345678\\>\n\\<t:0:R\\>",
    "**KO**\n\\*\\*bold\\*\\*",
    "-# ⏳ 再生待ち",
  ]);
});

void test("対応ペア外の発話警告も英語のComponents V2カードとして送る", async () => {
  const sent: CaptionMessagePayload[] = [];
  const captions = new DiscordCaptionGateway({
    send(payload: CaptionMessagePayload) {
      sent.push(payload);
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      });
    },
  });

  await captions.postUnsupportedLanguageWarning();

  const message = sent[0];
  assert.ok(message);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in message, false);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.deepEqual(textContents(message), [
    "**⚠ Speech not translated**\n-# Detected language is outside the selected pair.",
  ]);
});

void test("字幕カード上限超過は既定で警告にして音声翻訳を継続できる", async () => {
  let sent = false;
  const warnings: { operation: string; error: unknown }[] = [];
  const captions = new DiscordCaptionGateway({
    send() {
      sent = true;
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      });
    },
  }, {
    onWarning(operation, error) {
      warnings.push({ operation, error });
    },
  });

  const reference = await captions.post({
    utteranceId: "u-too-long",
    sessionId: "s1",
    speakerUserId: "user1",
    speakerDisplayName: "sota",
    voiceId: "speaker-test-voice",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    originalText: "あ".repeat(2_000),
    translatedText: "가".repeat(2_000),
    sourceDurationMs: 500,
    state: "pending",
  });

  assert.equal(reference, undefined);
  assert.equal(sent, false);
  const warning = warnings[0];
  assert.ok(warning);
  assert.equal(warning.operation, "caption_post");
  assert.ok(warning.error instanceof ApplicationError);
});

void test("厳格設定では後続の最長状態が上限を超える字幕を送信前に拒否する", async () => {
  let sent = false;
  const captions = new DiscordCaptionGateway({
    send() {
      sent = true;
      return Promise.resolve({
        edit: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      });
    },
  }, { failurePolicy: "stop_session" });

  await assert.rejects(
    captions.post({
      utteranceId: "u-status-reserve",
      sessionId: "s1",
      speakerUserId: "user1",
      speakerDisplayName: "sota",
      voiceId: "speaker-test-voice",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      originalText: "あ".repeat(3_952),
      translatedText: "가",
      sourceDurationMs: 500,
      state: "pending",
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "CAPTION_SEND_FAILED",
  );
  assert.equal(sent, false);
});
