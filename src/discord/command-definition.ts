import {
  InteractionContextType,
  SlashCommandBuilder,
} from "discord.js";

import { languagePairs } from "../domain/language-pair.js";

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
            ...languagePairs.map((pair) => ({ name: pair, value: pair })),
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stop")
      .setDescription("実行中の翻訳を直ちに停止します"),
  );
