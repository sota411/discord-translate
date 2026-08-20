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
  playbackModeLabels,
  playbackModes,
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
      .setName("stop")
      .setDescription("実行中の翻訳を直ちに停止します"),
  );

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("現在の翻訳セッションの状態を表示します")
  .setContexts(InteractionContextType.Guild);

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
  .setDescription("特殊な用語と希望する翻訳を登録します")
  .setContexts(InteractionContextType.Guild)
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
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("target")
      .setDescription("希望する翻訳")
      .setRequired(true),
  );
