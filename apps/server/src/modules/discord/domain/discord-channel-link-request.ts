import {
  createDiscordApprovalButtonId,
  parseDiscordApprovalButtonId,
  type DiscordApprovalAction,
} from "./discord-approval-request";

export interface DiscordChannelLinkRequest {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
}

export interface PendingDiscordChannelLinkRequest extends DiscordChannelLinkRequest {
  readonly requestId: string;
  readonly pendingMessageId?: string;
  readonly expiresAt?: string;
}

const REQUEST_BUTTON_PREFIX = "channel-link";

export const DISCORD_CHANNEL_LINK_BUTTON_PREFIX = REQUEST_BUTTON_PREFIX;

export function createDiscordChannelLinkButtonId(
  action: DiscordApprovalAction,
  requestId: string,
): string {
  return createDiscordApprovalButtonId(REQUEST_BUTTON_PREFIX, action, requestId);
}

export function parseDiscordChannelLinkButtonId(
  customId: string,
): { action: DiscordApprovalAction; requestId: string } | undefined {
  return parseDiscordApprovalButtonId(REQUEST_BUTTON_PREFIX, customId);
}
