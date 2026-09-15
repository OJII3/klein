import { REST, Routes } from "discord.js";

import { loadConfig } from "../src/app/config";

interface DiscordApplicationCommand {
  readonly id: string;
  readonly name: string;
}

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

const rest = new REST({ version: "10" }).setToken(token);
let removedCount = 0;

for (const guildId of guildIds) {
  const commands = (await rest.get(
    Routes.applicationGuildCommands(applicationId, guildId),
  )) as DiscordApplicationCommand[];
  const legacyCommands = commands.filter((command) => command.name === "usage");

  await Promise.all(
    legacyCommands.map((command) =>
      rest.delete(Routes.applicationGuildCommand(applicationId, guildId, command.id)),
    ),
  );
  removedCount += legacyCommands.length;
}

console.log(`Removed ${removedCount} legacy Discord usage command(s)`);
