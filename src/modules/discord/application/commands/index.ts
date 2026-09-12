import type { DiscordSlashCommandDefinition } from "../../ports/discord-service.js";
import { OPENCODE_GO_USAGE_COMMAND_DEFINITION } from "./opencode-go-usage-command.js";

export const DISCORD_SLASH_COMMAND_DEFINITIONS: readonly DiscordSlashCommandDefinition[] = [
  OPENCODE_GO_USAGE_COMMAND_DEFINITION,
];
