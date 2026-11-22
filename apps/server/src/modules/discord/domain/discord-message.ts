export interface DiscordUser {
  readonly bot: boolean;
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

export interface DiscordImageAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface DiscordMessage {
  readonly occurredAt: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly id: string;
  readonly images: readonly DiscordImageAttachment[];
  readonly replyTo?: DiscordReplyReference;
}

export interface DiscordMessageLocator {
  readonly channelId: string;
  readonly messageId: string;
}

export interface DiscordChannelHistoryAttachment {
  readonly filename: string;
  readonly url: string;
}

export interface DiscordChannelHistoryMessage {
  readonly id: string;
  readonly channelId: string;
  readonly occurredAt: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly attachments: readonly DiscordChannelHistoryAttachment[];
}

export interface DiscordChannelHistoryPageRequest {
  readonly channelId: string;
  readonly limit: number;
  readonly before?: string;
  readonly after?: string;
}

export type DiscordChannelHistoryOrder = "newest" | "oldest";

const DISCORD_REPLY_PREVIEW_LIMIT = 256;
export const DISCORD_CHANNEL_HISTORY_CONTENT_LIMIT = 1_500;

export function formatDiscordUser(user: DiscordUser): string {
  if (user.displayName === user.username) return user.displayName;

  return `${user.displayName} (@${user.username})`;
}

export function formatDiscordReply(reply: DiscordReplyReference): string {
  const author = reply.author?.displayName ?? "不明なユーザー";
  const content = reply.content?.replaceAll(/\s+/gu, " ").trim() ?? "";
  const preview = Array.from(content).slice(0, DISCORD_REPLY_PREVIEW_LIMIT).join("");
  const truncated = content.length > preview.length ? `${preview}…` : preview;

  return `↪ ${author}${truncated ? `: ${truncated}` : ""} ⟦${reply.id}⟧`;
}

export function formatDiscordMessage(message: DiscordMessage): string {
  const replyContext = message.replyTo ? `${formatDiscordReply(message.replyTo)}\n` : "";
  const content = message.content || "(画像のみ)";
  const imageContext =
    message.images.length > 0
      ? `\n[添付画像: ${message.images.map((image) => image.filename).join(", ")}]`
      : "";

  return `${replyContext}${formatDiscordUser(message.author)}:\n${content}${imageContext}`;
}

export function formatDiscordChannelHistoryMessage(
  message: DiscordChannelHistoryMessage,
  contentLimit = DISCORD_CHANNEL_HISTORY_CONTENT_LIMIT,
): string {
  const characters = Array.from(message.content);
  const content =
    characters.length > contentLimit
      ? `${characters.slice(0, contentLimit).join("")}… (truncated, ${characters.length} chars total)`
      : message.content;
  const attachmentContext =
    message.attachments.length > 0
      ? `\n[添付: ${message.attachments
          .map((attachment) => `${attachment.filename} (${attachment.url})`)
          .join(", ")}]`
      : "";

  return (
    `[${message.id}] ${message.occurredAt} | ${formatDiscordUser(message.author)} | userId=${message.author.id}\n` +
    `${content || "(本文なし)"}${attachmentContext}`
  );
}

export function resolveDiscordMentions(
  content: string,
  resolvers: {
    readonly user: (userId: string) => DiscordUser | undefined;
    readonly role: (roleId: string) => DiscordRole | undefined;
  },
): string {
  return content.replaceAll(/<@([!&]?)(\d+)>/g, (mention, kind: string, id: string) => {
    if (kind === "&") {
      const role = resolvers.role(id);
      return role ? `@${role.name}` : mention;
    }

    const user = resolvers.user(id);
    return user ? `@${formatDiscordUser(user)}` : mention;
  });
}
