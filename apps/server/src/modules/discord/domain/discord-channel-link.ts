export interface DiscordChannelLink {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId: string;
  readonly linkedAt: string;
}

export interface DiscordChannelLinkTarget {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

export function discordChannelLinkLocationKey(target: DiscordChannelLinkTarget): string {
  return `${target.guildId}:${target.channelId}:${target.threadId ?? ""}`;
}
