import { REST, Routes } from "discord.js";

import { loadConfig } from "./config.js";
import {
  guildCommands,
} from "./discord/command-definition.js";
import { createSafeLogger } from "./observability/logger.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discord.token);
const logger = createSafeLogger(config.logIdHmacKey);

for (const guildId of config.discord.allowedGuildIds) {
  await rest.put(
    Routes.applicationGuildCommands(config.discord.applicationId, guildId),
    {
      body: guildCommands.map((command) => command.toJSON()),
    },
  );
  logger.info("guild_commands_registered", {
    guild_id: logger.pseudonymize(guildId),
  });
}
