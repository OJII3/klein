export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface DiscordMessage {
  readonly channelId: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly author: DiscordUser;
  readonly content: string;
}

export function formatDiscordUser(user: DiscordUser): string {
  if (user.displayName === user.username) return user.displayName;

  return `${user.displayName} (@${user.username})`;
}

export function resolveDiscordUserMentions(
  content: string,
  resolveUser: (userId: string) => DiscordUser | undefined,
): string {
  return content.replace(/<@!?(\d+)>/g, (mention, userId: string) => {
    const user = resolveUser(userId);
    return user ? `@${formatDiscordUser(user)}` : mention;
  });
}
