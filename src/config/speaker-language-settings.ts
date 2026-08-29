import { ApplicationError } from "../domain/application-error.js";
import {
  languagesForPair,
  type Language,
  type LanguagePair,
} from "../domain/language-pair.js";

export const speakerLanguageModes = ["auto", "ja", "ko", "en"] as const;
export type SpeakerLanguageMode = (typeof speakerLanguageModes)[number];

export const speakerLanguageModeLabels: Readonly<Record<SpeakerLanguageMode, string>> = {
  auto: "自動判定",
  ja: "日本語",
  ko: "韓国語",
  en: "英語",
};

export type SpeakerLanguageSettingInput = {
  guildId: string;
  userId: string;
  mode: SpeakerLanguageMode;
  updatedAt: Date;
};

export type SpeakerLanguageSettingStore = {
  getStoredSpeakerLanguageMode(
    guildId: string,
    userId: string,
  ): SpeakerLanguageMode | undefined;
  upsertStoredSpeakerLanguageMode(input: SpeakerLanguageSettingInput): void;
};

export type SpeakerLanguageSelection = {
  mode: SpeakerLanguageMode;
  source: "guild" | "environment" | "automatic";
};

export class SpeakerLanguageSettings {
  readonly #environmentDefaults: ReadonlyMap<string, Language>;
  readonly #store: SpeakerLanguageSettingStore;

  public constructor(
    environmentDefaults: ReadonlyMap<string, Language>,
    store: SpeakerLanguageSettingStore,
  ) {
    this.#environmentDefaults = environmentDefaults;
    this.#store = store;
  }

  public selection(guildId: string, userId: string): SpeakerLanguageSelection {
    let stored: SpeakerLanguageMode | undefined;
    try {
      stored = this.#store.getStoredSpeakerLanguageMode(guildId, userId);
    } catch (error) {
      throw this.#storeUnavailable(error);
    }
    if (stored !== undefined) return { mode: stored, source: "guild" };

    const environmentDefault = this.#environmentDefaults.get(userId);
    return environmentDefault === undefined
      ? { mode: "auto", source: "automatic" }
      : { mode: environmentDefault, source: "environment" };
  }

  public set(input: {
    guildId: string;
    userId: string;
    mode: string;
    at: Date;
  }): SpeakerLanguageMode {
    if (!isSpeakerLanguageMode(input.mode)) {
      throw new ApplicationError(
        "UNSUPPORTED_LANGUAGE",
        "対応していない話者言語です。コマンドを再登録してください。",
      );
    }
    try {
      this.#store.upsertStoredSpeakerLanguageMode({
        guildId: input.guildId,
        userId: input.userId,
        mode: input.mode,
        updatedAt: input.at,
      });
      return input.mode;
    } catch (error) {
      throw this.#storeUnavailable(error);
    }
  }

  public resolve(
    guildId: string,
    userId: string,
    pair: LanguagePair,
  ): Language | undefined {
    const { mode } = this.selection(guildId, userId);
    if (mode === "auto" || !languagesForPair(pair).includes(mode)) return undefined;
    return mode;
  }

  #storeUnavailable(cause: unknown): ApplicationError {
    return new ApplicationError(
      "SPEAKER_LANGUAGE_STORE_UNAVAILABLE",
      "話者言語の設定を保存または読み込みできませんでした。時間を置いて再実行してください。",
      { cause },
    );
  }
}

export function isSpeakerLanguageMode(value: string): value is SpeakerLanguageMode {
  return speakerLanguageModes.includes(value as SpeakerLanguageMode);
}
