import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranslationTerm } from "../src/config/translation-terms.js";
import {
  TranslationTermCatalog,
  type RegisteredTranslationTermInput,
  type TranslationTermStore,
} from "../src/config/translation-term-catalog.js";
import { ApplicationError } from "../src/domain/application-error.js";
import type { LanguagePair } from "../src/domain/language-pair.js";

class MemoryTermStore implements TranslationTermStore {
  readonly #terms = new Map<string, TranslationTerm>();

  public listRegisteredTranslationTerms(
    guildId: string,
    pair: LanguagePair,
  ): readonly TranslationTerm[] {
    const prefix = `${guildId}:${pair}:`;
    return [...this.#terms.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, term]) => ({ ...term }))
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  public upsertRegisteredTranslationTerm(input: RegisteredTranslationTermInput): void {
    this.#terms.set(`${input.guildId}:${input.pair}:${input.source}`, {
      source: input.source,
      target: input.target,
    });
  }

  public deleteRegisteredTranslationTerm(
    guildId: string,
    pair: LanguagePair,
    source: string,
  ): boolean {
    return this.#terms.delete(`${guildId}:${pair}:${source}`);
  }
}

const staticTerms = {
  "ja-ko": [{ source: "VALORANT", target: "발로란트" }],
  "ja-en": [],
  "ko-en": [],
} as const;

void test("コマンド用語はGuild別に永続化し、登録済みsourceだけを更新する", () => {
  const store = new MemoryTermStore();
  const catalog = new TranslationTermCatalog(staticTerms, store, false);
  const at = new Date("2026-08-21T03:00:00Z");

  assert.equal(catalog.register({
    guildId: "guild-1",
    pair: "ja-ko",
    source: "  ult  ",
    target: "  궁극기  ",
    at,
  }), "created");
  assert.equal(catalog.register({
    guildId: "guild-1",
    pair: "ja-ko",
    source: "ult",
    target: "필살기",
    at,
  }), "updated");
  assert.equal(catalog.register({
    guildId: "guild-2",
    pair: "ja-ko",
    source: "ult",
    target: "궁극기",
    at,
  }), "created");

  assert.deepEqual(catalog.snapshot("guild-1", "ja-ko"), [
    { source: "VALORANT", target: "발로란트" },
    { source: "ult", target: "필살기" },
  ]);
  assert.deepEqual(catalog.snapshot("guild-2", "ja-ko"), [
    { source: "VALORANT", target: "발로란트" },
    { source: "ult", target: "궁극기" },
  ]);
});

void test("静的用語との衝突、空入力、Soniox context上限を登録前に拒否する", () => {
  const catalog = new TranslationTermCatalog(
    staticTerms,
    new MemoryTermStore(),
    false,
  );
  const common = {
    guildId: "guild-1",
    pair: "ja-ko" as const,
    at: new Date("2026-08-21T03:00:00Z"),
  };

  assert.throws(
    () => catalog.register({ ...common, source: "VALORANT", target: "다른 번역" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_CONFLICT",
  );
  assert.throws(
    () => catalog.register({ ...common, source: "   ", target: "translation" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_INVALID",
  );
  const fullStore = new MemoryTermStore();
  for (let index = 0; index < 80; index += 1) {
    fullStore.upsertRegisteredTranslationTerm({
      guildId: "guild-1",
      pair: "ja-ko",
      source: `term-${String(index).padStart(2, "0")}`,
      target: "x".repeat(100),
      updatedAt: common.at,
    });
  }
  const fullCatalog = new TranslationTermCatalog(staticTerms, fullStore, false);
  assert.throws(
    () => fullCatalog.register({ ...common, source: "large", target: "translation" }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "TRANSLATION_TERM_LIMIT_REACHED",
  );
  assert.throws(
    () => catalog.register({ ...common, source: "x".repeat(101), target: "translation" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_INVALID",
  );
  assert.throws(
    () => catalog.register({ ...common, source: "term", target: "x".repeat(101) }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_INVALID",
  );
});

void test("用語登録はgeneral contextの有効時だけ固定文を上限へ含める", () => {
  const nearLimitStaticTerms = {
    "ja-ko": [{ source: "baseline", target: "x".repeat(9_400) }],
    "ja-en": [],
    "ko-en": [],
  } as const;
  const input = {
    guildId: "guild-1",
    pair: "ja-ko" as const,
    source: "term",
    target: "translation",
    at: new Date("2026-08-21T03:00:00Z"),
  };

  const disabled = new TranslationTermCatalog(
    nearLimitStaticTerms,
    new MemoryTermStore(),
    false,
  );
  assert.equal(disabled.register(input), "created");

  const enabled = new TranslationTermCatalog(
    nearLimitStaticTerms,
    new MemoryTermStore(),
    true,
  );
  assert.throws(
    () => enabled.register(input),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "TRANSLATION_TERM_LIMIT_REACHED",
  );
});

void test("Guild登録用語だけを全ペアまたは指定ペアで一覧化し、完全一致で削除する", () => {
  const store = new MemoryTermStore();
  const catalog = new TranslationTermCatalog(staticTerms, store, false);
  const at = new Date("2026-08-21T03:00:00Z");
  catalog.register({
    guildId: "guild-1",
    pair: "ja-en",
    source: "技術室",
    target: "technology room",
    at,
  });
  catalog.register({
    guildId: "guild-1",
    pair: "ja-ko",
    source: "ult",
    target: "궁극기",
    at,
  });
  catalog.register({
    guildId: "guild-2",
    pair: "ja-ko",
    source: "ace",
    target: "에이스",
    at,
  });

  assert.deepEqual(catalog.listRegisteredTerms("guild-1"), [
    { pair: "ja-ko", source: "ult", target: "궁극기" },
    { pair: "ja-en", source: "技術室", target: "technology room" },
  ]);
  assert.deepEqual(catalog.listRegisteredTerms("guild-1", "ja-en"), [
    { pair: "ja-en", source: "技術室", target: "technology room" },
  ]);

  catalog.delete({ guildId: "guild-1", pair: "ja-ko", source: "ult" });
  assert.deepEqual(catalog.listRegisteredTerms("guild-1", "ja-ko"), []);
  assert.throws(
    () => catalog.delete({ guildId: "guild-1", pair: "ja-ko", source: "ULT" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_NOT_FOUND",
  );
  assert.throws(
    () => catalog.delete({ guildId: "guild-1", pair: "ja-ko", source: "VALORANT" }),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "TRANSLATION_TERM_CONFLICT",
  );

  store.upsertRegisteredTranslationTerm({
    guildId: "guild-1",
    pair: "ja-ko",
    source: " legacy ",
    target: "레거시",
    updatedAt: at,
  });
  catalog.delete({ guildId: "guild-1", pair: "ja-ko", source: " legacy " });
  assert.deepEqual(catalog.listRegisteredTerms("guild-1", "ja-ko"), []);
});

void test("起動時検査は静的用語と保存済み用語の衝突をFail Fastで報告する", () => {
  const store = new MemoryTermStore();
  store.upsertRegisteredTranslationTerm({
    guildId: "guild-1",
    pair: "ja-ko",
    source: "VALORANT",
    target: "발로란트",
    updatedAt: new Date("2026-08-21T03:00:00Z"),
  });
  const catalog = new TranslationTermCatalog(staticTerms, store, false);

  assert.throws(
    () => catalog.assertGuildsValid(new Set(["guild-1"])),
    /静的用語と登録用語でsourceが重複/u,
  );
});

void test("保存済み用語のsourceまたはtargetが100文字を超えればFail Fastにする", () => {
  for (const term of [
    { source: "s".repeat(101), target: "translation" },
    { source: "term", target: "t".repeat(101) },
  ]) {
    const store = new MemoryTermStore();
    store.upsertRegisteredTranslationTerm({
      guildId: "guild-1",
      pair: "ja-en",
      ...term,
      updatedAt: new Date("2026-08-21T03:00:00Z"),
    });
    const catalog = new TranslationTermCatalog(staticTerms, store, false);

    assert.throws(
      () => catalog.listRegisteredTerms("guild-1", "ja-en"),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "TRANSLATION_TERM_INVALID" &&
        error.publicMessage.includes("100文字以内"),
    );
    assert.throws(
      () => catalog.assertGuildsValid(new Set(["guild-1"])),
      /保存済みのsourceとtargetはそれぞれ100文字以内/u,
    );
  }
});
