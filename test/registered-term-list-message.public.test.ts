import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComponentType,
  MessageFlags,
} from "discord.js";

import type { RegisteredTranslationTerm } from "../src/config/translation-term-catalog.js";
import { createRegisteredTermListMessagePayload } from "../src/discord/registered-term-list-message.js";

function terms(count: number): RegisteredTranslationTerm[] {
  return Array.from({ length: count }, (_, index) => ({
    pair: index % 2 === 0 ? "ja-ko" : "ja-en",
    source: `source-${String(index).padStart(2, "0")}`,
    target: `target-${String(index).padStart(2, "0")}`,
  }));
}

function componentJson(payload: ReturnType<typeof createRegisteredTermListMessagePayload>) {
  return payload.components[0].toJSON();
}

function collectComponents(value: unknown, type: ComponentType): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = record.type === type ? [record] : [];
  const children = Array.isArray(record.components)
    ? record.components.flatMap((child) => collectComponents(child, type))
    : [];
  return [...own, ...children];
}

void test("登録用語を10件ずつComponents V2で表示し、前後ページを操作できる", () => {
  const first = createRegisteredTermListMessagePayload({
    terms: terms(23),
    filter: "all",
    requestedPage: 0,
  });
  assert.equal(first.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(first.allowedMentions, { parse: [] });
  const firstJson = componentJson(first);
  const firstText = collectComponents(firstJson, ComponentType.TextDisplay)
    .map((component) => component.content)
    .join("\n");
  assert.match(firstText, /23件 · 1 \/ 3ページ/u);
  assert.match(firstText, /source-00/u);
  assert.doesNotMatch(firstText, /source-10/u);
  const firstButtons = collectComponents(firstJson, ComponentType.Button);
  const firstPrevious = firstButtons[0];
  const firstNext = firstButtons[1];
  assert.ok(firstPrevious);
  assert.ok(firstNext);
  assert.equal(firstPrevious.disabled, true);
  assert.equal(firstNext.disabled, false);
  assert.equal(firstNext.custom_id, "register:list:all:1");

  const last = createRegisteredTermListMessagePayload({
    terms: terms(23),
    filter: "all",
    requestedPage: 99,
  });
  const lastJson = componentJson(last);
  const lastText = collectComponents(lastJson, ComponentType.TextDisplay)
    .map((component) => component.content)
    .join("\n");
  assert.match(lastText, /23件 · 3 \/ 3ページ/u);
  assert.match(lastText, /source-22/u);
  const lastButtons = collectComponents(lastJson, ComponentType.Button);
  const lastPrevious = lastButtons[0];
  const lastNext = lastButtons[1];
  assert.ok(lastPrevious);
  assert.ok(lastNext);
  assert.equal(lastPrevious.custom_id, "register:list:all:1");
  assert.equal(lastPrevious.disabled, false);
  assert.equal(lastNext.disabled, true);
});

void test("登録用語がなければ次の操作を示し、ページボタンを表示しない", () => {
  const payload = createRegisteredTermListMessagePayload({
    terms: [],
    filter: "ja-ko",
    requestedPage: 0,
  });
  const json = componentJson(payload);
  const text = collectComponents(json, ComponentType.TextDisplay)
    .map((component) => component.content)
    .join("\n");
  assert.match(text, /登録済みの翻訳用語はありません/u);
  assert.match(text, /\/register add/u);
  assert.equal(collectComponents(json, ComponentType.Button).length, 0);
});

void test("用語をMarkdownやmentionとして解釈させず、1ページを上限内に保つ", () => {
  const longTerms = terms(10).map((term, index) => ({
    ...term,
    source: index === 0 ? "@everyone **source**" : "x".repeat(100),
    target: "y".repeat(100),
  }));
  const payload = createRegisteredTermListMessagePayload({
    terms: longTerms,
    filter: "all",
    requestedPage: 0,
  });
  const textDisplays = collectComponents(
    componentJson(payload),
    ComponentType.TextDisplay,
  );
  assert.ok(textDisplays.every((component) =>
    typeof component.content === "string" && component.content.length <= 3_500));
  assert.match(JSON.stringify(textDisplays), /\\@everyone/u);
});

void test("件数とページ番号を含む表示全体を3,500文字以内に保つ", () => {
  const escapedTerms = Array.from({ length: 9 }, (_, index) => ({
    pair: "ja-ko" as const,
    source: `${"~".repeat(92)}${String(index).padStart(2, "0")}`,
    target: "~".repeat(94),
  }));
  const payload = createRegisteredTermListMessagePayload({
    terms: escapedTerms,
    filter: "ja-ko",
    requestedPage: 0,
  });
  const textDisplays = collectComponents(
    componentJson(payload),
    ComponentType.TextDisplay,
  );

  assert.ok(textDisplays.every((component) =>
    typeof component.content === "string" && component.content.length <= 3_500));
});
