import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { AgentTurn } from "../core/agent-turn";

export interface DiscordTurnContext {
  readonly userMemory?: string;
  readonly sharedMemory?: string;
  readonly channelRule?: string;
  readonly proactivePreferences?: string;
  readonly waitingOn?: string;
  readonly pendingSignals?: string;
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
      ...(context.sharedMemory ||
      context.channelRule ||
      context.proactivePreferences ||
      context.waitingOn ||
      context.pendingSignals
        ? {
            blocks: [
              ...(context.sharedMemory
                ? [{ name: "shared-memory", content: context.sharedMemory }]
                : []),
              ...(context.channelRule
                ? [{ name: "channel-rule", content: context.channelRule }]
                : []),
              ...(context.proactivePreferences
                ? [{ name: "proactive-preferences", content: context.proactivePreferences }]
                : []),
              ...(context.waitingOn ? [{ name: "waiting-on", content: context.waitingOn }] : []),
              ...(context.pendingSignals
                ? [{ name: "pending-signals", content: context.pendingSignals }]
                : []),
            ],
          }
        : {}),
      ...(message.author.bot ? {} : { requesterId: message.author.id }),
    },
  };
}
