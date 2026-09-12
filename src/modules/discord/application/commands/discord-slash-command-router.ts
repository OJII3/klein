import type {
  DiscordSlashCommandContext,
  DiscordSlashCommandHandler,
} from "../../ports/discord-service.js";

export interface DiscordSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly handler: DiscordSlashCommandHandler;
}

export function createDiscordSlashCommandRouter(
  commands: readonly DiscordSlashCommand[],
): DiscordSlashCommandHandler {
  const handlers = new Map(commands.map((command) => [command.name, command.handler]));

  return async (interaction: DiscordSlashCommandContext): Promise<void> => {
    await handlers.get(interaction.commandName)?.(interaction);
  };
}
