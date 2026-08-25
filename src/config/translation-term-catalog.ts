import {
  assertTranslationTermsFitContext,
  type TranslationTerm,
  type TranslationTerms,
} from "./translation-terms.js";
import { ApplicationError } from "../domain/application-error.js";
import {
  languagePairs,
  type LanguagePair,
} from "../domain/language-pair.js";

export type RegisteredTranslationTermInput = {
  guildId: string;
  pair: LanguagePair;
  source: string;
  target: string;
  updatedAt: Date;
};

export type RegisteredTranslationTerm = TranslationTerm & {
  pair: LanguagePair;
};

export const registeredTranslationTermMaxLength = 100;

export type TranslationTermStore = {
  listRegisteredTranslationTerms(
    guildId: string,
    pair: LanguagePair,
  ): readonly TranslationTerm[];
  upsertRegisteredTranslationTerm(input: RegisteredTranslationTermInput): void;
  deleteRegisteredTranslationTerm(
    guildId: string,
    pair: LanguagePair,
    source: string,
  ): boolean;
};

export type RegisterTranslationTermInput = {
  guildId: string;
  pair: LanguagePair;
  source: string;
  target: string;
  at: Date;
};

export type DeleteTranslationTermInput = {
  guildId: string;
  pair: LanguagePair;
  source: string;
};

export class TranslationTermCatalog {
  readonly #staticTerms: TranslationTerms;
  readonly #store: TranslationTermStore;
  readonly #includeGeneralContext: boolean;

  public constructor(
    staticTerms: TranslationTerms,
    store: TranslationTermStore,
    includeGeneralContext: boolean,
  ) {
    this.#staticTerms = staticTerms;
    this.#store = store;
    this.#includeGeneralContext = includeGeneralContext;
  }

  public snapshot(guildId: string, pair: LanguagePair): readonly TranslationTerm[] {
    const staticEntries = this.#staticTerms[pair];
    const registeredEntries = this.#listRegistered(guildId, pair);
    const staticSources = new Set(staticEntries.map((entry) => entry.source));
    if (registeredEntries.some((entry) => staticSources.has(entry.source))) {
      throw new ApplicationError(
        "TRANSLATION_TERM_CONFLICT",
        "静的用語と登録用語でsourceが重複しています。運営者へ連絡してください。",
      );
    }
    const merged = [
      ...staticEntries.map((entry) => ({ ...entry })),
      ...registeredEntries.map((entry) => ({ ...entry })),
    ];
    try {
      assertTranslationTermsFitContext(
        pair,
        merged,
        this.#includeGeneralContext,
      );
    } catch (error) {
      throw new ApplicationError(
        "TRANSLATION_TERM_LIMIT_REACHED",
        "登録済み用語がSoniox contextの上限を超えています。運営者へ連絡してください。",
        { cause: error },
      );
    }
    return merged;
  }

  public register(input: RegisterTranslationTermInput): "created" | "updated" {
    const source = input.source.trim();
    const target = input.target.trim();
    if (source.length === 0 || target.length === 0) {
      throw new ApplicationError(
        "TRANSLATION_TERM_INVALID",
        "sourceとtargetには空でない用語を指定してください。",
      );
    }
    if (
      Array.from(source).length > registeredTranslationTermMaxLength ||
      Array.from(target).length > registeredTranslationTermMaxLength
    ) {
      throw new ApplicationError(
        "TRANSLATION_TERM_INVALID",
        `sourceとtargetはそれぞれ${String(registeredTranslationTermMaxLength)}文字以内で指定してください。`,
      );
    }
    if (this.#staticTerms[input.pair].some((entry) => entry.source === source)) {
      throw new ApplicationError(
        "TRANSLATION_TERM_CONFLICT",
        "同じsourceが運用者の静的用語ファイルに登録されています。",
      );
    }

    const registered = this.#listRegistered(input.guildId, input.pair);
    const existing = registered.find((entry) => entry.source === source);
    const next = existing
      ? registered.map((entry) => entry.source === source
        ? { source, target }
        : entry)
      : [...registered, { source, target }];
    const merged = [...this.#staticTerms[input.pair], ...next];
    try {
      assertTranslationTermsFitContext(
        input.pair,
        merged,
        this.#includeGeneralContext,
      );
    } catch (error) {
      throw new ApplicationError(
        "TRANSLATION_TERM_LIMIT_REACHED",
        "この言語ペアの用語はSoniox contextの10,000文字上限を超えるため登録できません。",
        { cause: error },
      );
    }
    try {
      this.#store.upsertRegisteredTranslationTerm({
        guildId: input.guildId,
        pair: input.pair,
        source,
        target,
        updatedAt: input.at,
      });
    } catch (error) {
      throw new ApplicationError(
        "TRANSLATION_TERM_STORE_UNAVAILABLE",
        "翻訳用語を保存できませんでした。時間を置いて再実行してください。",
        { cause: error },
      );
    }
    return existing ? "updated" : "created";
  }

  public listRegisteredTerms(
    guildId: string,
    pair?: LanguagePair,
  ): readonly RegisteredTranslationTerm[] {
    const pairs = pair === undefined ? languagePairs : [pair];
    return pairs.flatMap((currentPair) =>
      this.#listRegistered(guildId, currentPair).map((term) => ({
        pair: currentPair,
        source: term.source,
        target: term.target,
      })));
  }

  public delete(input: DeleteTranslationTermInput): void {
    const source = input.source;
    if (source.trim().length === 0) {
      throw new ApplicationError(
        "TRANSLATION_TERM_INVALID",
        "削除するsourceを指定してください。",
      );
    }
    if (this.#staticTerms[input.pair].some((entry) => entry.source === source)) {
      throw new ApplicationError(
        "TRANSLATION_TERM_CONFLICT",
        "このsourceは運用者の静的用語ファイルにあり、コマンドでは削除できません。",
      );
    }
    let deleted: boolean;
    try {
      deleted = this.#store.deleteRegisteredTranslationTerm(
        input.guildId,
        input.pair,
        source,
      );
    } catch (error) {
      throw new ApplicationError(
        "TRANSLATION_TERM_STORE_UNAVAILABLE",
        "翻訳用語を削除できませんでした。時間を置いて再実行してください。",
        { cause: error },
      );
    }
    if (!deleted) {
      throw new ApplicationError(
        "TRANSLATION_TERM_NOT_FOUND",
        "削除する登録用語が見つかりません。一覧または入力候補から選び直してください。",
      );
    }
  }

  public assertGuildsValid(guildIds: ReadonlySet<string>): void {
    for (const guildId of guildIds) {
      for (const pair of languagePairs) {
        try {
          this.snapshot(guildId, pair);
        } catch (error) {
          const message = error instanceof ApplicationError
            ? error.publicMessage
            : "翻訳用語を検証できませんでした。";
          throw new Error(`Guild ${guildId}の登録済み翻訳用語が不正です: ${message}`, {
            cause: error,
          });
        }
      }
    }
  }

  #listRegistered(guildId: string, pair: LanguagePair): readonly TranslationTerm[] {
    let terms: readonly TranslationTerm[];
    try {
      terms = this.#store.listRegisteredTranslationTerms(guildId, pair);
    } catch (error) {
      throw new ApplicationError(
        "TRANSLATION_TERM_STORE_UNAVAILABLE",
        "登録済み翻訳用語を読み込めません。時間を置いて再実行してください。",
        { cause: error },
      );
    }
    if (terms.some((term) =>
      Array.from(term.source).length > registeredTranslationTermMaxLength ||
      Array.from(term.target).length > registeredTranslationTermMaxLength)) {
      throw new ApplicationError(
        "TRANSLATION_TERM_INVALID",
        `保存済みのsourceとtargetはそれぞれ${String(registeredTranslationTermMaxLength)}文字以内である必要があります。運営者へ連絡してください。`,
      );
    }
    return terms;
  }
}
