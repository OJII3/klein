import {
  createDiscordApprovalButtonId,
  discordApprovalLocationKey,
  parseDiscordApprovalButtonId,
  type DiscordApprovalAction,
  type DiscordApprovalNoticeOutcome,
  type DiscordApprovalRejection,
} from "./discord-approval-request";

export interface DiscordChannelAccessRequest {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
}

export interface PendingDiscordAccessRequest extends DiscordChannelAccessRequest {
  readonly requestId: string;
  readonly pendingMessageId?: string;
  readonly ownerMessageId?: string;
  readonly expiresAt?: string;
}

export type DiscordChannelAccessAction = DiscordApprovalAction;

export type DiscordChannelAccessRejection = DiscordApprovalRejection;

export type DiscordChannelAccessNoticeOutcome = DiscordApprovalNoticeOutcome;

const REQUEST_BUTTON_PREFIX = "channel-access";

export const DISCORD_CHANNEL_ACCESS_BUTTON_PREFIX = REQUEST_BUTTON_PREFIX;

export function createDiscordChannelAccessButtonId(
  action: DiscordChannelAccessAction,
  requestId: string,
): string {
  return createDiscordApprovalButtonId(REQUEST_BUTTON_PREFIX, action, requestId);
}

export function parseDiscordChannelAccessButtonId(
  customId: string,
): { action: DiscordChannelAccessAction; requestId: string } | undefined {
  return parseDiscordApprovalButtonId(REQUEST_BUTTON_PREFIX, customId);
}

export function discordChannelAccessRequestLocationKey(
  request: DiscordChannelAccessRequest,
): string {
  return discordApprovalLocationKey(request);
}
