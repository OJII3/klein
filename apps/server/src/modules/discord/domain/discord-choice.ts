import type { DiscordMessage, DiscordUser } from "./discord-message";

export interface DiscordChoiceRequest {
  readonly question: string;
  readonly options: readonly string[];
  readonly requesterUserId: string;
}

export interface DiscordChoiceChannel {
  readonly id: string;
  readonly name?: string;
  readonly parentId?: string;
  readonly isThread: boolean;
}

export interface DiscordChoiceButton {
  readonly id: string;
  readonly customId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly channel?: DiscordChoiceChannel;
  readonly user: DiscordUser;
  readonly botUser?: DiscordUser;
}

export interface PendingDiscordChoice extends DiscordChoiceRequest {
  readonly nonce: string;
  readonly channelId: string;
  readonly messageId: string;
}

const CHOICE_BUTTON_PREFIX = "choice";

export function createDiscordChoiceButtonId(nonce: string, index: number): string {
  return `${CHOICE_BUTTON_PREFIX}:${nonce}:${index}`;
}

export function parseDiscordChoiceButtonId(
  customId: string,
): { nonce: string; index: number } | undefined {
  const [prefix, nonce, rawIndex] = customId.split(":");
  if (prefix !== CHOICE_BUTTON_PREFIX || !nonce || rawIndex === undefined) return undefined;
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return { nonce, index };
}

export function createDiscordChoiceAnswerMessage(
  button: DiscordChoiceButton,
  pending: PendingDiscordChoice,
  label: string,
): DiscordMessage {
  const channel = button.channel;
  const thread = channel?.isThread ? channel : undefined;
  const channelName = channel?.name ? channel.name : undefined;

  return {
    id: button.id,
    occurredAt: new Date().toISOString(),
    channelId: button.channelId,
    ...(channelName ? { channelName } : {}),
    ...(button.guildId ? { guildId: button.guildId } : {}),
    ...(thread?.parentId ? { parentChannelId: thread.parentId } : {}),
    ...(thread?.id ? { threadId: thread.id } : {}),
    author: button.user,
    content: label,
    images: [],
    replyTo: {
      id: pending.messageId,
      ...(button.botUser ? { author: button.botUser } : {}),
      content: pending.question,
    },
  };
}
