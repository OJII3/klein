import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy.js";
import type { DiscordMessage } from "../domain/discord-message.js";
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

function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
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

    const content = stripBotMention(message.content, botId);
    if (!content) return;
    const thread = message.channel.isThread() ? message.channel : undefined;
    if (!isSendableChannel(message.channel)) return;

    this.channels.set(message.channelId, message.channel);

    const parentChannelId = thread?.parentId ?? undefined;
    const normalizedMessage: DiscordMessage = {
      authorName: message.member?.displayName ?? message.author.username,
      channelId: message.channelId,
      content,
      guildId: message.guildId ?? undefined,
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

    await this.onMessage?.(normalizedMessage);
  }
}
