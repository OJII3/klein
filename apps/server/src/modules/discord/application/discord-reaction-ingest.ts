import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordReactionEvent } from "../domain/discord-reaction";

export interface DiscordReactionMessageSnapshot {
  readonly id: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly content?: string;
  readonly authorId?: string;
  readonly channel?: {
    readonly id?: string;
    readonly name?: string;
    readonly parentId?: string;
    readonly isThread?: boolean;
  };
}

export interface DiscordReactionSnapshot {
  readonly message: DiscordReactionMessageSnapshot;
  readonly emojiName: string | null;
  readonly emojiIdentifier: string;
  readonly userId: string;
  readonly userIsBot: boolean;
}

export interface DiscordReactionIngestDependencies {
  readonly accessPolicy: Pick<DiscordAccessPolicy, "canReceive">;
  readonly selfUserId: () => string | undefined;
  readonly canAccept: () => boolean;
  readonly onReaction: (event: DiscordReactionEvent) => Promise<void>;
}

/**
 * Turns a reaction on a message the bot posted into a domain event. Reactions
 * on other messages, from bots, and in channels without access are ignored.
 */
export class DiscordReactionIngest {
  constructor(private readonly dependencies: DiscordReactionIngestDependencies) {}

  async handle(reaction: DiscordReactionSnapshot): Promise<boolean> {
    if (!this.dependencies.canAccept()) return false;
    if (reaction.userIsBot) return false;

    const selfUserId = this.dependencies.selfUserId();
    if (selfUserId && reaction.userId === selfUserId) return false;
    if (selfUserId && reaction.message.authorId !== selfUserId) return false;

    const channel = reaction.message.channel;
    const thread = channel?.isThread ? channel : undefined;
    if (
      !this.dependencies.accessPolicy.canReceive({
        guildId: reaction.message.guildId,
        channelId: thread?.parentId ?? reaction.message.channelId,
        threadId: thread?.id,
        userId: reaction.userId,
        userIsBot: reaction.userIsBot,
      })
    ) {
      return false;
    }

    const emoji = reaction.emojiName ?? reaction.emojiIdentifier;
    if (!emoji) return false;

    await this.dependencies.onReaction({
      emoji,
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
      ...(reaction.message.guildId ? { guildId: reaction.message.guildId } : {}),
      ...(thread?.parentId ? { parentChannelId: thread.parentId } : {}),
      ...(thread?.id ? { threadId: thread.id } : {}),
      ...(channel?.name ? { channelName: channel.name } : {}),
      ...(reaction.message.authorId ? { messageAuthorId: reaction.message.authorId } : {}),
      ...(reaction.message.content ? { messageContent: reaction.message.content } : {}),
      userId: reaction.userId,
      userIsBot: reaction.userIsBot,
      occurredAt: new Date().toISOString(),
    });
    return true;
  }
}
