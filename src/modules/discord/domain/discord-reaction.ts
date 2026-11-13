export interface DiscordReactionEvent {
  readonly emoji: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly channelName?: string;
  readonly messageAuthorId?: string;
  readonly messageContent?: string;
  readonly userId: string;
  readonly userIsBot: boolean;
  readonly occurredAt: string;
}
