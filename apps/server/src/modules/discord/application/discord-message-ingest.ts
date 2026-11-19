import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordChannelAccessRequest } from "../domain/discord-access-request";
import type { DiscordMessage } from "../domain/discord-message";
import type { DiscordMessageHandler } from "../ports/discord-gateway";
import type {
  DiscordGatewayMessage,
  DiscordGatewayMessageReader,
} from "../ports/discord-gateway-message";

export interface DiscordMessageIngestDependencies {
  readonly accessPolicy: Pick<DiscordAccessPolicy, "canReceive" | "resolveAccess">;
  readonly reader: DiscordGatewayMessageReader;
  readonly selfUserId: () => string | undefined;
  readonly canAccept: () => boolean;
  readonly onMessage: DiscordMessageHandler;
  readonly requestAccess?: (request: DiscordChannelAccessRequest) => Promise<void>;
}

function isSendableChannel(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}
export class DiscordMessageIngest {
  constructor(private readonly dependencies: DiscordMessageIngestDependencies) {}

  async handle(message: DiscordGatewayMessage): Promise<boolean> {
    if (!this.dependencies.canAccept()) return false;
    if (message.author.id === this.dependencies.selfUserId()) return false;

    const content = message.content.trim();
    if (!content && !this.dependencies.reader.hasSupportedImageAttachment(message)) return false;
    if (!isSendableChannel(message.channel)) return false;

    const normalizedMessage = this.dependencies.reader.toDiscordMessage(message);

    if (!this.dependencies.canAccept()) return false;

    const accessTarget = {
      guildId: normalizedMessage.guildId,
      channelId: normalizedMessage.parentChannelId ?? normalizedMessage.channelId,
      threadId: normalizedMessage.threadId,
      userId: message.author.id,
      userIsBot: message.author.bot,
    };

    if (!this.dependencies.accessPolicy.canReceive(accessTarget)) {
      if (this.dependencies.accessPolicy.resolveAccess(accessTarget) === "deny") {
        await this.requestAccessWhenMentioned(message, normalizedMessage);
      }
      return false;
    }

    if (!this.dependencies.canAccept()) return false;

    const [images, replyTo] = await Promise.all([
      this.dependencies.reader.fetchImages(message),
      this.dependencies.reader.fetchReplyReference(message),
    ]);

    if (!this.dependencies.canAccept()) return false;
    if (!content && images.length === 0) return false;

    await this.dependencies.onMessage({
      ...normalizedMessage,
      images,
      replyTo,
    });
    return true;
  }

  private async requestAccessWhenMentioned(
    message: DiscordGatewayMessage,
    normalizedMessage: DiscordMessage,
  ): Promise<void> {
    if (!normalizedMessage.guildId || message.author.bot) return;

    const selfUserId = this.dependencies.selfUserId();
    if (!selfUserId || !message.mentions.users.has(selfUserId)) return;

    await this.dependencies.requestAccess?.({
      guildId: normalizedMessage.guildId,
      channelId: normalizedMessage.parentChannelId ?? normalizedMessage.channelId,
      ...(normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : {}),
      pendingChannelId: normalizedMessage.channelId,
      ...(normalizedMessage.channelName ? { channelName: normalizedMessage.channelName } : {}),
      requesterUserId: normalizedMessage.author.id,
    });
  }
}
