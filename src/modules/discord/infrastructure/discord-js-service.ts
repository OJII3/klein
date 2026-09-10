import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy.js";
import {
  resolveDiscordMentions,
  type DiscordMessage,
  type DiscordMessageLocator,
  type DiscordReplyReference,
  type DiscordUser,
} from "../domain/discord-message.js";
import type { DiscordMessageHandler, DiscordService } from "../ports/discord-service.js";

const DISCORD_MESSAGE_LIMIT = 2_000;

interface SendableChannel {
  send(content: string): Promise<unknown>;
}

function isSendableChannel(value: unknown): value is SendableChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

function splitMessage(content: string): string[] {
  const chunks: string[] = [];

  for (let offset = 0; offset < content.length; offset += DISCORD_MESSAGE_LIMIT) {
    chunks.push(content.slice(offset, offset + DISCORD_MESSAGE_LIMIT));
  }

  return chunks;
}

function toDiscordUser(message: Message): DiscordUser {
  return {
    id: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName ?? message.author.displayName,
  };
}

export class DiscordJsService implements DiscordService {
  private readonly client: Client;
  private readonly channels = new Map<string, SendableChannel>();
  private onMessage?: DiscordMessageHandler;
  private messageListener?: (message: Message) => void;
  private acceptingMessages = false;
  private readonly logger?: Logger;

  constructor(
    private readonly token: string,
    private readonly accessPolicy: DiscordAccessPolicy,
    logger?: Logger,
  ) {
    this.logger = logger?.child({ component: "discord-service" });
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(onMessage: DiscordMessageHandler): Promise<void> {
    this.onMessage = onMessage;
    this.acceptingMessages = true;
    this.client.once(Events.ClientReady, (readyClient) => {
      this.logger?.info(
        {
          event: "discord_client_ready",
          userId: readyClient.user.id,
        },
        "Discord client is ready",
      );
    });
    this.messageListener = (message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.logger?.error(
          { err: error, event: "discord_message_handler_failed" },
          "Failed to handle Discord message",
        );
      });
    };
    this.client.on(Events.MessageCreate, this.messageListener);

    await this.client.login(this.token);
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    for (const chunk of splitMessage(content)) {
      await channel.send(chunk);
    }
  }

  async readMessage(locator: DiscordMessageLocator): Promise<DiscordMessage> {
    const channel = await this.client.channels.fetch(locator.channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel cannot contain messages: ${locator.channelId}`);
    }

    const message = await channel.messages.fetch(locator.messageId);
    const normalizedMessage = this.toDiscordMessage(message);

    return {
      ...normalizedMessage,
      replyTo: await this.fetchReplyReference(message),
    };
  }

  stopAccepting(): void {
    this.acceptingMessages = false;

    if (this.messageListener) {
      this.client.off(Events.MessageCreate, this.messageListener);
      this.messageListener = undefined;
    }
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
    this.stopAccepting();
    this.channels.clear();
    this.client.destroy();
  }

  private async getChannel(channelId: string): Promise<SendableChannel> {
    const cachedChannel = this.channels.get(channelId);
    if (cachedChannel) return cachedChannel;

    const channel = await this.client.channels.fetch(channelId);
    if (!isSendableChannel(channel)) {
      throw new Error(`Discord channel is not sendable: ${channelId}`);
    }

    this.channels.set(channelId, channel);
    return channel;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!this.acceptingMessages) return;
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content) return;
    if (!isSendableChannel(message.channel)) return;

    this.channels.set(message.channelId, message.channel);

    const normalizedMessage = this.toDiscordMessage(message);

    if (!this.acceptingMessages) return;

    if (
      !this.accessPolicy.canReceive({
        guildId: normalizedMessage.guildId,
        channelId: normalizedMessage.parentChannelId ?? normalizedMessage.channelId,
        threadId: normalizedMessage.threadId,
      })
    ) {
      return;
    }

    await this.onMessage?.({
      ...normalizedMessage,
      replyTo: await this.fetchReplyReference(message),
    });
  }

  private toDiscordMessage(message: Message): DiscordMessage {
    const thread = message.channel.isThread() ? message.channel : undefined;

    return {
      author: toDiscordUser(message),
      channelId: message.channelId,
      content: this.normalizeMessageContent(message),
      guildId: message.guildId ?? undefined,
      id: message.id,
      parentChannelId: thread?.parentId ?? undefined,
      threadId: thread?.id,
    };
  }

  private normalizeMessageContent(message: Message): string {
    const content = message.content.trim();

    return resolveDiscordMentions(content, {
      user: (userId) => {
        const user = message.mentions.users.get(userId);
        if (!user) return undefined;

        return {
          id: user.id,
          username: user.username,
          displayName: message.mentions.members?.get(userId)?.displayName ?? user.displayName,
        };
      },
      role: (roleId) => {
        const role = message.mentions.roles.get(roleId);
        return role ? { id: role.id, name: role.name } : undefined;
      },
    });
  }

  private async fetchReplyReference(message: Message): Promise<DiscordReplyReference | undefined> {
    const messageId = message.reference?.messageId;
    if (!messageId) return undefined;

    try {
      const referencedMessage = await message.fetchReference();
      return {
        author: toDiscordUser(referencedMessage),
        content: this.normalizeMessageContent(referencedMessage),
        id: referencedMessage.id,
      };
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_reply_reference_fetch_failed",
          messageId,
        },
        "Failed to fetch Discord reply reference",
      );
      return { id: messageId };
    }
  }
}
