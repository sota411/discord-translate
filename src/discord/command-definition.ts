import {
  ChannelType,
  InteractionContextType,
  SlashCommandBuilder,
} from "discord.js";

import {
  languagePairLabels,
  languagePairs,
} from "../domain/language-pair.js";
import {
  speakerLanguageModeLabels,
  speakerLanguageModes,
} from "../config/speaker-language-settings.js";
import {
  playbackModeLabels,
  playbackModes,
  ttsSpeedMax,
  ttsSpeedMin,
} from "../session/session-settings.js";

export const translateCommand = new SlashCommandBuilder()
  .setName("translate")
  .setDescription("音声チャンネルの会話をリアルタイム翻訳します")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("start")
      .setDescription("参加中の音声チャンネルで翻訳を開始します")
      .addStringOption((option) =>
        option
          .setName("pair")
          .setDescription("翻訳する言語ペア")
          .setRequired(true)
          .addChoices(
            ...languagePairs.map((pair) => ({
              name: languagePairLabels[pair],
              value: pair,
            })),
          ),
      )
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("読み上げが遅れたときの動作")
          .setRequired(false)
          .addChoices(
            ...playbackModes.map((mode) => ({
              name: playbackModeLabels[mode],
              value: mode,
            })),
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("speed")
      .setDescription("実行中の翻訳音声の読み上げ速度を変更します")
      .addNumberOption((option) =>
        option
          .setName("rate")
          .setDescription("読み上げ速度（0.7〜1.3倍）")
          .setRequired(true)
          .setMinValue(ttsSpeedMin)
          .setMaxValue(ttsSpeedMax),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stop")
      .setDescription("実行中の翻訳を直ちに停止します"),
  );

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("現在の翻訳セッションの状態を表示します")
  .setContexts(InteractionContextType.Guild);

export const languageCommand = new SlashCommandBuilder()
  .setName("language")
  .setDescription("話者ごとの音声認識言語を確認・変更します")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("show")
      .setDescription("現在の音声認識言語を表示します")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("確認する利用者。省略時は自分です")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("音声認識で優先する言語を設定します")
      .addStringOption((option) =>
        option
          .setName("language")
          .setDescription("音声認識で優先する言語")
          .setRequired(true)
          .addChoices(...speakerLanguageModes.map((mode) => ({
            name: speakerLanguageModeLabels[mode],
            value: mode,
          }))),
      )
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("設定する利用者。省略時は自分です")
          .setRequired(false),
      ),
  );

export const exportCommand = new SlashCommandBuilder()
  .setName("export")
  .setDescription("翻訳スレッドの確定字幕をMarkdownで出力します")
  .setContexts(InteractionContextType.Guild)
  .addChannelOption((option) =>
    option
      .setName("thread")
      .setDescription("対象の翻訳スレッド。省略時は現在のスレッドです")
      .setRequired(false)
      .addChannelTypes(ChannelType.PublicThread),
  );

export const registerCommand = new SlashCommandBuilder()
  .setName("register")
  .setDescription("特殊な用語の登録・一覧表示・削除を管理します")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("特殊な用語と希望する翻訳を登録または更新します")
      .addStringOption((option) =>
        option
          .setName("pair")
          .setDescription("用語を使う言語ペア")
          .setRequired(true)
          .addChoices(...languagePairs.map((pair) => ({
            name: languagePairLabels[pair],
            value: pair,
          }))),
      )
      .addStringOption((option) =>
        option
          .setName("source")
          .setDescription("翻訳前の特殊な用語")
          .setRequired(true)
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName("target")
          .setDescription("希望する翻訳")
          .setRequired(true)
          .setMaxLength(100),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("登録済みの翻訳用語を一覧表示します")
      .addStringOption((option) =>
        option
          .setName("pair")
          .setDescription("表示する言語ペア。省略時はすべて表示します")
          .setRequired(false)
          .addChoices(...languagePairs.map((pair) => ({
            name: languagePairLabels[pair],
            value: pair,
          }))),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("登録済みの翻訳用語を削除します")
      .addStringOption((option) =>
        option
          .setName("pair")
          .setDescription("削除する用語の言語ペア")
          .setRequired(true)
          .addChoices(...languagePairs.map((pair) => ({
            name: languagePairLabels[pair],
            value: pair,
          }))),
      )
      .addStringOption((option) =>
        option
          .setName("source")
          .setDescription("削除する登録済み用語")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

export const guildCommands = [
  translateCommand,
  statusCommand,
  exportCommand,
  registerCommand,
  languageCommand,
] as const;
