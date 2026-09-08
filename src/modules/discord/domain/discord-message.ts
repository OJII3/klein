export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface DiscordRole {
  readonly id: string;
  readonly name: string;
}

export interface DiscordReplyReference {
  readonly id: string;
  readonly author?: DiscordUser;
  readonly content?: string;
}

export interface DiscordMessage {
  readonly channelId: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly id: string;
  readonly replyTo?: DiscordReplyReference;
}

const DISCORD_REPLY_PREVIEW_LIMIT = 256;

export function formatDiscordUser(user: DiscordUser): string {
  if (user.displayName === user.username) return user.displayName;

  return `${user.displayName} (@${user.username})`;
}

export function formatDiscordReply(reply: DiscordReplyReference): string {
  const author = reply.author?.displayName ?? "不明なユーザー";
  const content = reply.content?.replace(/\s+/gu, " ").trim() ?? "";
  const preview = Array.from(content).slice(0, DISCORD_REPLY_PREVIEW_LIMIT).join("");
  const truncated = content.length > preview.length ? `${preview}…` : preview;

  return `↪ ${author}${truncated ? `: ${truncated}` : ""} ⟦${reply.id}⟧`;
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
