import type { DiscordSlashCommandDefinition } from "../../ports/discord-service.js";
import { OPENCODE_GO_LIMIT_COMMAND_DEFINITION } from "./opencode-go-limit-command.js";

export const DISCORD_SLASH_COMMAND_DEFINITIONS: readonly DiscordSlashCommandDefinition[] = [
  OPENCODE_GO_LIMIT_COMMAND_DEFINITION,
];
