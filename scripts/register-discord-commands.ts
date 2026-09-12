import { loadConfig } from "../src/app/config.js";
import { DISCORD_SLASH_COMMAND_DEFINITIONS } from "../src/modules/discord/application/commands/index.js";
import { registerDiscordCommands } from "../src/modules/discord/infrastructure/discord-command-registration.js";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}
if (!applicationId) {
  throw new Error("DISCORD_APPLICATION_ID is required");
}

const config = await loadConfig();
const guildIds = Object.keys(config.discord.access.guilds ?? {});
if (guildIds.length === 0) {
  throw new Error("At least one Discord guild must be configured in discord.access.guilds");
}

for (const guildId of guildIds) {
  await registerDiscordCommands({
    applicationId,
    commands: DISCORD_SLASH_COMMAND_DEFINITIONS,
    guildId,
    token,
  });
}

console.log(
  `Registered ${DISCORD_SLASH_COMMAND_DEFINITIONS.length} Discord slash command(s) for ${guildIds.length} configured guild(s)`,
);
