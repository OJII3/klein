export interface DiscordApprovalLocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

export interface DiscordApprovalRequest extends DiscordApprovalLocation {
  readonly requestId: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
  readonly pendingMessageId?: string;
  readonly expiresAt?: string;
}

export type DiscordApprovalRequestDraft<R extends DiscordApprovalRequest> = Omit<
  R,
  "requestId" | "pendingMessageId" | "expiresAt"
>;

export const DISCORD_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;

export function isDiscordApprovalExpired(
  request: Pick<DiscordApprovalRequest, "expiresAt">,
  now: number,
): boolean {
  if (!request.expiresAt) return true;
  const expiresAt = Date.parse(request.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export type DiscordApprovalAction = "allow" | "deny";

export type DiscordApprovalNoticeOutcome = "allowed" | "denied" | "owner-unreachable";

export type DiscordApprovalRejection = "owner-only" | "expired" | "update-failed" | "conflict";

export function discordApprovalLocationKey(location: DiscordApprovalLocation): string {
  return `${location.guildId}:${location.channelId}:${location.threadId ?? ""}`;
}

export function createDiscordApprovalButtonId(
  prefix: string,
  action: DiscordApprovalAction,
  requestId: string,
): string {
  return `${prefix}:${action}:${requestId}`;
}

export function parseDiscordApprovalButtonId(
  prefix: string,
  customId: string,
): { action: DiscordApprovalAction; requestId: string } | undefined {
  const [actualPrefix, action, requestId] = customId.split(":");
  if (actualPrefix !== prefix || !requestId) return undefined;
  if (action !== "allow" && action !== "deny") return undefined;
  return { action, requestId };
}
