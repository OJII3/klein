export interface DiscordMessage {
  readonly channelId: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly authorName: string;
  readonly content: string;
}
