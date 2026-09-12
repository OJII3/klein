import { REST, Routes } from "discord.js";

import type { DiscordSlashCommandDefinition } from "../ports/discord-service.js";

export interface RegisterDiscordCommandsOptions {
  readonly applicationId: string;
  readonly commands: readonly DiscordSlashCommandDefinition[];
  readonly guildId: string;
  readonly token: string;
}

export async function registerDiscordCommands(
  options: RegisterDiscordCommandsOptions,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(options.token);
  const route = Routes.applicationGuildCommands(options.applicationId, options.guildId);

  await rest.put(route, { body: [...options.commands] });
}
