import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SpeakerLanguageSettings,
  type SpeakerLanguageMode,
  type SpeakerLanguageSettingInput,
  type SpeakerLanguageSettingStore,
} from "../src/config/speaker-language-settings.js";
import { ApplicationError } from "../src/domain/application-error.js";

class MemorySpeakerLanguageStore implements SpeakerLanguageSettingStore {
  public readonly settings = new Map<string, SpeakerLanguageMode>();
  public error: Error | undefined;

  public getStoredSpeakerLanguageMode(
    guildId: string,
    userId: string,
  ): SpeakerLanguageMode | undefined {
    if (this.error) throw this.error;
    return this.settings.get(`${guildId}:${userId}`);
  }

  public upsertStoredSpeakerLanguageMode(input: SpeakerLanguageSettingInput): void {
    if (this.error) throw this.error;
    this.settings.set(`${input.guildId}:${input.userId}`, input.mode);
  }
}

const guildId = "223456789012345678";
const userId = "323456789012345678";

void test("未登録時は環境既定値を使い、選択ペア外なら従来の自動判定へ戻す", () => {
  const settings = new SpeakerLanguageSettings(
    new Map([[userId, "ko"]]),
    new MemorySpeakerLanguageStore(),
  );

  assert.deepEqual(settings.selection(guildId, userId), {
    mode: "ko",
    source: "environment",
  });
  assert.equal(settings.resolve(guildId, userId, "ja-ko"), "ko");
  assert.equal(settings.resolve(guildId, userId, "ja-en"), undefined);
});

void test("Guild設定は環境既定値より優先し、autoも再起動可能な明示値として扱う", () => {
  const store = new MemorySpeakerLanguageStore();
  const settings = new SpeakerLanguageSettings(
    new Map([[userId, "ko"]]),
    store,
  );

  settings.set({
    guildId,
    userId,
    mode: "ja",
    at: new Date("2026-08-30T00:00:00Z"),
  });
  assert.deepEqual(settings.selection(guildId, userId), {
    mode: "ja",
    source: "guild",
  });
  assert.equal(settings.resolve(guildId, userId, "ja-ko"), "ja");

  settings.set({
    guildId,
    userId,
    mode: "auto",
    at: new Date("2026-08-30T00:01:00Z"),
  });
  assert.deepEqual(settings.selection(guildId, userId), {
    mode: "auto",
    source: "guild",
  });
  assert.equal(settings.resolve(guildId, userId, "ja-ko"), undefined);
  assert.deepEqual(settings.selection("999999999999999999", userId), {
    mode: "ko",
    source: "environment",
  });
});

void test("環境にもGuildにも設定がなければ自動判定を表示する", () => {
  const settings = new SpeakerLanguageSettings(
    new Map(),
    new MemorySpeakerLanguageStore(),
  );

  assert.deepEqual(settings.selection(guildId, userId), {
    mode: "auto",
    source: "automatic",
  });
});

void test("保存障害は自動判定へ隠さず利用者向けエラーにする", () => {
  const store = new MemorySpeakerLanguageStore();
  store.error = new Error("sqlite unavailable");
  const settings = new SpeakerLanguageSettings(new Map(), store);

  assert.throws(
    () => settings.selection(guildId, userId),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "SPEAKER_LANGUAGE_STORE_UNAVAILABLE",
  );
  assert.throws(
    () => settings.set({
      guildId,
      userId,
      mode: "ko",
      at: new Date("2026-08-30T00:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "SPEAKER_LANGUAGE_STORE_UNAVAILABLE",
  );
});

void test("未対応の言語値は保存前に拒否する", () => {
  const store = new MemorySpeakerLanguageStore();
  const settings = new SpeakerLanguageSettings(new Map(), store);

  assert.throws(
    () => settings.set({
      guildId,
      userId,
      mode: "unknown",
      at: new Date("2026-08-30T00:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UNSUPPORTED_LANGUAGE",
  );
  assert.equal(store.settings.size, 0);
});
