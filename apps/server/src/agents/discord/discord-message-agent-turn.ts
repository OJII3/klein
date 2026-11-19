import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { AgentTurn } from "../core/agent-turn";

export interface DiscordTurnContext {
  readonly userMemory?: string;
  readonly guildMemory?: string;
  readonly channelRule?: string;
}

export interface DiscordMessageAgentTurnOptions {
  readonly botMessageGuidance?: string;
  readonly ownerValidation?: {
    readonly userId: string;
    readonly channelId: string;
  };
}

export function createDiscordMessageAgentTurn(
  message: DiscordMessage,
  context: DiscordTurnContext = {},
  options: DiscordMessageAgentTurnOptions = {},
): AgentTurn {
  if (
    options.ownerValidation &&
    (message.author.bot ||
      message.author.id !== options.ownerValidation.userId ||
      message.channelId !== options.ownerValidation.channelId)
  ) {
    throw new Error("Only the owner can use this Discord agent in its configured channel");
  }

  const formattedMessage = formatDiscordMessage(message);
  const text = `${formattedMessage}${message.author.bot ? (options.botMessageGuidance ?? "") : ""}`;

  return {
    event: {
      id: message.id,
      occurredAt: message.occurredAt,
      type: "discord.message",
      source: "discord",
      content: [
        { type: "text", text },
        ...message.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
      ],
    },
    context: {
      ...(context.userMemory ? { userMemory: context.userMemory } : {}),
      ...(context.guildMemory || context.channelRule
        ? {
            blocks: [
              ...(context.guildMemory
                ? [{ name: "guild-memory", content: context.guildMemory }]
                : []),
              ...(context.channelRule
                ? [{ name: "channel-rule", content: context.channelRule }]
                : []),
            ],
          }
        : {}),
      ...(message.author.bot ? {} : { requesterId: message.author.id }),
    },
  };
}
