export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface DiscordRole {
  readonly id: string;
  readonly name: string;
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

export function resolveDiscordMentions(
  content: string,
  resolvers: {
    readonly user: (userId: string) => DiscordUser | undefined;
    readonly role: (roleId: string) => DiscordRole | undefined;
  },
): string {
  return content.replace(/<@([!&]?)(\d+)>/g, (mention, kind: string, id: string) => {
    if (kind === "&") {
      const role = resolvers.role(id);
      return role ? `@${role.name}` : mention;
    }

    const user = resolvers.user(id);
    return user ? `@${formatDiscordUser(user)}` : mention;
  });
}
