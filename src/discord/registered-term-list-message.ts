import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  inlineCode,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";

import type { RegisteredTranslationTerm } from "../config/translation-term-catalog.js";
import {
  languagePairLabels,
  type LanguagePair,
} from "../domain/language-pair.js";
import type { ComponentsMessagePayload } from "./message-payload.js";

export type RegisteredTermListFilter = LanguagePair | "all";

const termsPerPage = 10;
const pageTextCharacterLimit = 3_500;

export function createRegisteredTermListMessagePayload(input: {
  terms: readonly RegisteredTranslationTerm[];
  filter: RegisteredTermListFilter;
  requestedPage: number;
}): ComponentsMessagePayload {
  const pages = paginate(input.terms, pageTermTextBudget(input.terms.length));
  const pageCount = Math.max(1, pages.length);
  const pageIndex = Math.min(
    Math.max(0, Number.isSafeInteger(input.requestedPage) ? input.requestedPage : 0),
    pageCount - 1,
  );
  const container = new ContainerBuilder();

  if (input.terms.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
      "**登録済みの翻訳用語**",
      "登録済みの翻訳用語はありません。`/register add`で登録できます。",
    ].join("\n")));
  } else {
    const pageTerms = pages[pageIndex] ?? [];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      renderPageText(pageTerms, input.terms.length, pageIndex + 1, pageCount),
    ));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`register:list:${input.filter}:${String(Math.max(0, pageIndex - 1))}`)
          .setLabel("前へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === 0),
        new ButtonBuilder()
          .setCustomId(`register:list:${input.filter}:${String(Math.min(pageCount - 1, pageIndex + 1))}`)
          .setLabel("次へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageIndex === pageCount - 1),
      ),
    );
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function paginate(
  terms: readonly RegisteredTranslationTerm[],
  termTextCharacterLimit: number,
): RegisteredTranslationTerm[][] {
  const pages: RegisteredTranslationTerm[][] = [];
  let page: RegisteredTranslationTerm[] = [];
  for (const term of terms) {
    const candidate = [...page, term];
    if (
      page.length > 0 &&
      (page.length >= termsPerPage || renderTerms(candidate).length > termTextCharacterLimit)
    ) {
      pages.push(page);
      page = [term];
      continue;
    }
    page = candidate;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function pageTermTextBudget(totalTerms: number): number {
  const largestPageNumber = Math.max(1, totalTerms);
  return pageTextCharacterLimit - renderPageText(
    [],
    totalTerms,
    largestPageNumber,
    largestPageNumber,
  ).length;
}

function renderPageText(
  terms: readonly RegisteredTranslationTerm[],
  totalTerms: number,
  pageNumber: number,
  pageCount: number,
): string {
  return [
    "**登録済みの翻訳用語**",
    `-# ${String(totalTerms)}件 · ${String(pageNumber)} / ${String(pageCount)}ページ`,
    "",
    renderTerms(terms),
  ].join("\n");
}

function renderTerms(terms: readonly RegisteredTranslationTerm[]): string {
  const lines: string[] = [];
  let previousPair: LanguagePair | undefined;
  for (const term of terms) {
    if (term.pair !== previousPair) {
      if (lines.length > 0) lines.push("");
      lines.push(`**${languagePairLabels[term.pair]}**`);
      previousPair = term.pair;
    }
    lines.push(`- ${displayValue(term.source)} → ${displayValue(term.target)}`);
  }
  return lines.join("\n");
}

function displayValue(value: string): string {
  const singleLine = value
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
  return inlineCode(escapeMarkdown(singleLine).replaceAll("@", "\\@"));
}
