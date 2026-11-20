import { discordChannelLinkLocationKey } from "./discord-channel-link";

export interface DiscordChannelAccessRequest {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
  /** When set, approval also registers this user as the location's owner. */
  readonly linkUserId?: string;
}

export interface PendingDiscordAccessRequest extends DiscordChannelAccessRequest {
  readonly requestId: string;
  readonly pendingMessageId?: string;
}

export type DiscordChannelAccessAction = "allow" | "deny";

export type DiscordChannelAccessRejection =
  "owner-only" | "expired" | "rule-update-failed" | "link-update-failed" | "link-conflict";

export type DiscordChannelAccessNoticeOutcome = "allowed" | "denied" | "owner-unreachable";

const REQUEST_BUTTON_PREFIX = "channel-access";

export function createDiscordChannelAccessButtonId(
  action: DiscordChannelAccessAction,
  requestId: string,
): string {
  return `${REQUEST_BUTTON_PREFIX}:${action}:${requestId}`;
}

export function parseDiscordChannelAccessButtonId(
  customId: string,
): { action: DiscordChannelAccessAction; requestId: string } | undefined {
  const [prefix, action, requestId] = customId.split(":");
  if (prefix !== REQUEST_BUTTON_PREFIX || !requestId) return undefined;
  if (action !== "allow" && action !== "deny") return undefined;
  return { action, requestId };
}

export function discordChannelAccessRequestLocationKey(
  request: DiscordChannelAccessRequest,
): string {
  return discordChannelLinkLocationKey(request);
}
