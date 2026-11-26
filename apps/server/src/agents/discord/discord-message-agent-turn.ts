import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { AgentTurn } from "../core/agent-turn";
import { BYSTANDER_MESSAGE_CONTENT_LIMIT } from "./prompt-policy";

export interface DiscordTurnContext {
  readonly userMemory?: string;
  readonly sharedMemory?: string;
  readonly channelRule?: string;
  readonly proactivePreferences?: string;
  readonly waitingOn?: string;
  readonly pendingSignals?: string;
  /** Why: the owner session must tell its owner apart from an admitted non-owner speaker. */
  readonly audience?: "owner" | "bystander";
}

export interface DiscordMessageAgentTurnOptions {
  readonly botMessageGuidance?: string;
  readonly bystanderMessageGuidance?: string;
  readonly ownerValidation?: {
    readonly userId: string;
    readonly channelId: string;
  };
}

function truncateForBystander(message: DiscordMessage): DiscordMessage {
  const characters = Array.from(message.content);
  if (characters.length <= BYSTANDER_MESSAGE_CONTENT_LIMIT) return message;
  return {
    ...message,
    content: `${characters.slice(0, BYSTANDER_MESSAGE_CONTENT_LIMIT).join("")}…`,
  };
}

export function createDiscordMessageAgentTurn(
  message: DiscordMessage,
  context: DiscordTurnContext = {},
  options: DiscordMessageAgentTurnOptions = {},
): AgentTurn {
  const bystander = context.audience === "bystander" && !message.author.bot;
  if (
    options.ownerValidation &&
    !bystander &&
    (message.author.bot ||
      message.author.id !== options.ownerValidation.userId ||
      message.channelId !== options.ownerValidation.channelId)
  ) {
    throw new Error("Only the owner can use this Discord agent in its configured channel");
  }

  const formattedMessage = formatDiscordMessage(
    bystander ? truncateForBystander(message) : message,
  );
  const guidance = message.author.bot
    ? (options.botMessageGuidance ?? "")
    : bystander
      ? (options.bystanderMessageGuidance ?? "")
      : "";
  const text = `${formattedMessage}${guidance}`;

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
