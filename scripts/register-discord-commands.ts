import { DISCORD_SLASH_COMMAND_DEFINITIONS } from "../src/modules/discord/application/commands/index.js";
import { registerDiscordCommands } from "../src/modules/discord/infrastructure/discord-command-registration.js";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}
if (!applicationId) {
  throw new Error("DISCORD_APPLICATION_ID is required");
}

await registerDiscordCommands({
  applicationId,
  commands: DISCORD_SLASH_COMMAND_DEFINITIONS,
  guildId,
  token,
});

console.log(
  `Registered ${DISCORD_SLASH_COMMAND_DEFINITIONS.length} Discord slash command(s)${
    guildId ? ` for guild ${guildId}` : " globally"
  }`,
);
