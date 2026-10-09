import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  type Message,
  type Interaction,
} from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import {
  DiscordOperatingState,
  type DiscordOperatingMode,
} from "../domain/discord-operating-state";
import { type DiscordMessage, type DiscordMessageLocator } from "../domain/discord-message";
import type { DiscordMessageHandler, DiscordService } from "../ports/discord-service";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";
import {
  DiscordVoiceChatController,
  type DiscordVoiceChatControllerOptions,
} from "./discord-voice-chat-controller";
import { DiscordJsInteractionHandler } from "./discord-js-interaction-handler";
import { DiscordJsMessageAdapter } from "./discord-js-message-adapter";

const DISCORD_MESSAGE_LIMIT = 2_000;
interface SendableChannel {
  send(content: string | { files: AttachmentBuilder[] }): Promise<unknown>;
  sendTyping?(): Promise<void>;
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

export class DiscordJsService implements DiscordService {
  private readonly client: Client;
  private readonly channels = new Map<string, SendableChannel>();
  private readonly voiceChatController?: DiscordVoiceChatController;
  private readonly interactionHandler: DiscordJsInteractionHandler;
  private readonly messageAdapter: DiscordJsMessageAdapter;
  private onMessage?: DiscordMessageHandler;
  private messageListener?: (message: Message) => void;
  private interactionListener?: (interaction: Interaction) => void;
  private acceptingMessages = false;
  private readonly logger?: Logger;

  constructor(
    private readonly token: string,
    private readonly accessPolicy: DiscordAccessPolicy,
    logger?: Logger,
    private readonly operatingState = new DiscordOperatingState(),
    voiceChat?: DiscordVoiceChatControllerOptions,
    channelRuleStore?: DiscordChannelRuleStore,
  ) {
    this.logger = logger?.child({ component: "discord-service" });
    this.messageAdapter = new DiscordJsMessageAdapter(this.logger);
    this.voiceChatController = voiceChat
      ? new DiscordVoiceChatController(accessPolicy, logger, voiceChat)
      : undefined;
    this.interactionHandler = new DiscordJsInteractionHandler(
      (mode) => this.setOperatingMode(mode),
      this.voiceChatController,
      channelRuleStore,
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        ...(this.voiceChatController ? [GatewayIntentBits.GuildVoiceStates] : []),
      ],
      partials: [Partials.Channel],
    });
  }

  async start(onMessage: DiscordMessageHandler): Promise<void> {
    this.onMessage = onMessage;
    this.acceptingMessages = true;
    this.client.once(Events.ClientReady, (readyClient) => {
      this.applyOperatingModePresence();
      this.logger?.info(
        {
          event: "discord_client_ready",
          userId: readyClient.user.id,
        },
        "Discord client is ready",
      );
      void this.synchronizeCommands(readyClient)
        .then(() => {
          this.logger?.info(
            { event: "discord_commands_synchronized" },
            "Synchronized Discord commands",
          );
        })
        .catch((error: unknown) => {
          this.logger?.error(
            { err: error, event: "discord_commands_synchronization_failed" },
            "Failed to synchronize Discord commands",
          );
        });
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
    this.interactionListener = (interaction) => {
      void this.handleInteraction(interaction).catch((error: unknown) => {
        this.logger?.error(
          { err: error, event: "discord_interaction_handler_failed" },
          "Failed to handle Discord interaction",
        );
      });
    };
    this.client.on(Events.InteractionCreate, this.interactionListener);
    await this.client.login(this.token);
  }

  setActivity(name: string): void {
    if (!this.client.user) {
      throw new Error("Discord client is not ready");
    }

    this.client.user.setActivity(name);
  }

  setOperatingMode(mode: DiscordOperatingMode): void {
    this.operatingState.setMode(mode);
    this.applyOperatingModePresence();
    this.logger?.info(
      { event: "discord_operating_mode_changed", mode },
      "Changed Discord operating mode",
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    await channel.sendTyping?.();
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    for (const chunk of splitMessage(content)) {
      await channel.send(chunk);
    }
  }

  async sendAudio(channelId: string, audio: Uint8Array, filename: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    await channel.send({ files: [new AttachmentBuilder(Buffer.from(audio), { name: filename })] });
  }

  async readMessage(locator: DiscordMessageLocator): Promise<DiscordMessage> {
    const channel = await this.client.channels.fetch(locator.channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel cannot contain messages: ${locator.channelId}`);
    }

    const message = await channel.messages.fetch(locator.messageId);
    const normalizedMessage = this.messageAdapter.toDiscordMessage(message);
    const [images, replyTo] = await Promise.all([
      this.messageAdapter.fetchImages(message),
      this.messageAdapter.fetchReplyReference(message),
    ]);

    return {
      ...normalizedMessage,
      images,
      replyTo,
    };
  }

  stopAccepting(): void {
    this.acceptingMessages = false;

    if (this.messageListener) {
      this.client.off(Events.MessageCreate, this.messageListener);
      this.messageListener = undefined;
    }

    if (this.interactionListener) {
      this.client.off(Events.InteractionCreate, this.interactionListener);
      this.interactionListener = undefined;
    }
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
    this.stopAccepting();
    this.channels.clear();
    await this.voiceChatController?.stop();
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
    if (!this.canAcceptMessages()) return;
    if (message.author.id === this.client.user?.id) return;

    const content = message.content.trim();
    if (!content && !this.messageAdapter.hasSupportedImageAttachment(message)) return;
    if (!isSendableChannel(message.channel)) return;

    this.channels.set(message.channelId, message.channel);

    const normalizedMessage = this.messageAdapter.toDiscordMessage(message);

    if (!this.canAcceptMessages()) return;

    if (
      !this.accessPolicy.canReceive({
        guildId: normalizedMessage.guildId,
        channelId: normalizedMessage.parentChannelId ?? normalizedMessage.channelId,
        threadId: normalizedMessage.threadId,
      })
    ) {
      return;
    }

    if (!this.canAcceptMessages()) return;

    const [images, replyTo] = await Promise.all([
      this.messageAdapter.fetchImages(message),
      this.messageAdapter.fetchReplyReference(message),
    ]);

    if (!this.canAcceptMessages()) return;
    if (!content && images.length === 0) return;

    await this.onMessage?.({
      ...normalizedMessage,
      images,
      replyTo,
    });
  }

  private canAcceptMessages(): boolean {
    return this.acceptingMessages && this.operatingState.isActive();
  }

  private applyOperatingModePresence(): void {
    if (!this.client.user) return;

    this.client.user.setStatus(this.operatingState.isActive() ? "online" : "idle");
  }

  private async synchronizeCommands(readyClient: Client<true>): Promise<void> {
    await readyClient.application.commands.set([...this.interactionHandler.commands]);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    await this.interactionHandler.handle(interaction);
  }
}
