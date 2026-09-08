import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy.js";
import {
  resolveDiscordMentions,
  type DiscordMessage,
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

  constructor(
    private readonly token: string,
    private readonly accessPolicy: DiscordAccessPolicy,
  ) {
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
      console.log(`Logged in as ${readyClient.user.tag}`);
    });
    this.messageListener = (message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        console.error("Failed to handle Discord message:", error);
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

    const botId = this.client.user?.id;
    if (!botId) return;

    if (message.guildId && !message.mentions.users.has(botId)) return;

    const content = message.content.trim();
    if (!content) return;
    const thread = message.channel.isThread() ? message.channel : undefined;
    if (!isSendableChannel(message.channel)) return;

    this.channels.set(message.channelId, message.channel);

    const parentChannelId = thread?.parentId ?? undefined;
    const author = toDiscordUser(message);
    const normalizedMessage: DiscordMessage = {
      author,
      channelId: message.channelId,
      content: resolveDiscordMentions(content, {
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
      }),
      guildId: message.guildId ?? undefined,
      id: message.id,
      parentChannelId,
      threadId: thread?.id,
    };

    if (!this.acceptingMessages) return;

    if (
      !this.accessPolicy.canReceive({
        guildId: normalizedMessage.guildId,
        channelId: parentChannelId ?? normalizedMessage.channelId,
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

  private async fetchReplyReference(message: Message): Promise<DiscordReplyReference | undefined> {
    const messageId = message.reference?.messageId;
    if (!messageId) return undefined;

    try {
      const referencedMessage = await message.fetchReference();
      return {
        author: toDiscordUser(referencedMessage),
        content: referencedMessage.content.trim(),
        id: referencedMessage.id,
      };
    } catch (error) {
      console.warn(`Failed to fetch Discord reply reference: ${messageId}`, error);
      return { id: messageId };
    }
  }
}
