import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import {
  DiscordOperatingState,
  type DiscordOperatingMode,
} from "../domain/discord-operating-state";
import { type DiscordMessage, type DiscordMessageLocator } from "../domain/discord-message";
import type { DiscordReactionEvent } from "../domain/discord-reaction";
import type {
  DiscordChannelApi,
  DiscordChannelLocation,
  DiscordMessageRequester,
} from "../ports/discord-channel-api";
import type {
  DiscordGateway,
  DiscordMessageHandler,
  DiscordReactionHandler,
} from "../ports/discord-gateway";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordAccessRequestStore } from "../ports/discord-access-request-store";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";

import { DiscordChannelAccessRequester } from "./discord-channel-access-request";
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

export class DiscordJsService implements DiscordGateway, DiscordChannelApi {
  private readonly client: Client;
  private readonly channels = new Map<string, SendableChannel>();
  private readonly voiceChatController?: DiscordVoiceChatController;
  private readonly interactionHandler: DiscordJsInteractionHandler;
  private readonly messageAdapter: DiscordJsMessageAdapter;
  private readonly channelAccessRequester?: DiscordChannelAccessRequester;
  private onMessage?: DiscordMessageHandler;
  private onReaction?: DiscordReactionHandler;
  private messageListener?: (message: Message) => void;
  private reactionListener?: (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ) => void;
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
    accessRuleStore?: DiscordAccessRuleStore,
    ownerUserId?: string,
    accessRequestStore?: DiscordAccessRequestStore,
  ) {
    this.logger = logger?.child({ component: "discord-service" });
    this.messageAdapter = new DiscordJsMessageAdapter(this.logger);
    this.voiceChatController = voiceChat
      ? new DiscordVoiceChatController(accessPolicy, logger, voiceChat)
      : undefined;
    this.interactionHandler = new DiscordJsInteractionHandler(
      accessPolicy,
      (mode) => this.setOperatingMode(mode),
      this.voiceChatController,
      channelRuleStore,
      accessRuleStore,
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        ...(this.voiceChatController ? [GatewayIntentBits.GuildVoiceStates] : []),
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });
    this.channelAccessRequester =
      accessRuleStore && accessRequestStore
        ? new DiscordChannelAccessRequester(
            this.client,
            accessRuleStore,
            accessRequestStore,
            ownerUserId,
            this.logger,
          )
        : undefined;
  }

  async start(
    onMessage: DiscordMessageHandler,
    onReaction?: DiscordReactionHandler,
  ): Promise<void> {
    this.onMessage = onMessage;
    this.onReaction = onReaction;
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
    this.reactionListener = (reaction, user) => {
      void this.handleReactionAdd(reaction, user).catch((error: unknown) => {
        this.logger?.error(
          { err: error, event: "discord_reaction_handler_failed" },
          "Failed to handle Discord message reaction",
        );
      });
    };
    this.client.on(Events.MessageReactionAdd, this.reactionListener);
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

  async getChannelLocation(channelId: string): Promise<DiscordChannelLocation> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel cannot contain messages: ${channelId}`);
    }
    const thread = channel.isThread() ? channel : undefined;
    const channelName = "name" in channel && typeof channel.name === "string" ? channel.name : "";
    return {
      guildId: "guildId" in channel ? channel.guildId : undefined,
      channelId: thread?.parentId ?? channel.id,
      threadId: thread?.id,
      ...(channelName ? { channelName } : {}),
    };
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    await channel.sendTyping?.();
  }

  async sendMessage(channelId: string, content: string): Promise<readonly string[]> {
    const channel = await this.getChannel(channelId);
    const sentIds: string[] = [];

    for (const chunk of splitMessage(content)) {
      const sent = await channel.send(chunk);
      if (
        typeof sent === "object" &&
        sent !== null &&
        "id" in sent &&
        typeof sent.id === "string"
      ) {
        sentIds.push(sent.id);
      }
    }

    return sentIds;
  }

  async sendAudio(channelId: string, audio: Uint8Array, filename: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    await channel.send({ files: [new AttachmentBuilder(Buffer.from(audio), { name: filename })] });
  }

  async readMessage(
    locator: DiscordMessageLocator,
    requester?: DiscordMessageRequester,
  ): Promise<DiscordMessage> {
    const channel = await this.client.channels.fetch(locator.channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel cannot contain messages: ${locator.channelId}`);
    }

    const thread = channel.isThread() ? channel : undefined;
    if (
      !this.accessPolicy.canReceive({
        guildId: "guildId" in channel ? channel.guildId : undefined,
        channelId: thread?.parentId ?? channel.id,
        threadId: thread?.id,
        ...requester,
      })
    ) {
      throw new Error(`Discord channel access denied: ${locator.channelId}`);
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

    if (this.reactionListener) {
      this.client.off(Events.MessageReactionAdd, this.reactionListener);
      this.reactionListener = undefined;
    }

    if (this.interactionListener) {
      this.client.off(Events.InteractionCreate, this.interactionListener);
      this.interactionListener = undefined;
    }
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
    this.onReaction = undefined;
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
        userId: message.author.id,
        userIsBot: message.author.bot,
      })
    ) {
      if (normalizedMessage.guildId && !message.author.bot && this.isBotMentioned(message)) {
        await this.channelAccessRequester?.request({
          guildId: normalizedMessage.guildId,
          channelId: normalizedMessage.parentChannelId ?? normalizedMessage.channelId,
          ...(normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : {}),
          pendingChannelId: normalizedMessage.channelId,
          ...(normalizedMessage.channelName ? { channelName: normalizedMessage.channelName } : {}),
          requesterUserId: normalizedMessage.author.id,
        });
      }
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

  private async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (!this.canAcceptMessages() || !this.onReaction) return;

    const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction;
    const resolvedMessage = resolvedReaction.message.partial
      ? await resolvedReaction.message.fetch()
      : resolvedReaction.message;
    const resolvedUser = user.partial ? await user.fetch() : user;

    if (!this.canAcceptMessages()) return;
    if (resolvedUser.bot || resolvedUser.id === this.client.user?.id) return;

    const botUserId = this.client.user?.id;
    if (botUserId && resolvedMessage.author?.id !== botUserId) return;

    const channel = resolvedMessage.channel;
    const thread = channel?.isThread?.() ? channel : undefined;
    const parentChannelId = thread?.parentId ?? undefined;
    const channelId = resolvedMessage.channelId;
    const guildId = resolvedMessage.guildId ?? undefined;
    const channelName =
      channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;

    if (
      !this.accessPolicy.canReceive({
        guildId,
        channelId: parentChannelId ?? channelId,
        threadId: thread?.id,
        userId: resolvedUser.id,
        userIsBot: Boolean(resolvedUser.bot),
      })
    ) {
      return;
    }

    const emoji = resolvedReaction.emoji.name ?? resolvedReaction.emoji.identifier;
    if (!emoji) return;

    const event: DiscordReactionEvent = {
      emoji,
      messageId: resolvedMessage.id,
      channelId,
      ...(guildId ? { guildId } : {}),
      ...(parentChannelId ? { parentChannelId } : {}),
      ...(thread?.id ? { threadId: thread.id } : {}),
      ...(channelName ? { channelName } : {}),
      ...(resolvedMessage.author?.id ? { messageAuthorId: resolvedMessage.author.id } : {}),
      ...(typeof resolvedMessage.content === "string" && resolvedMessage.content.length > 0
        ? { messageContent: resolvedMessage.content }
        : {}),
      userId: resolvedUser.id,
      userIsBot: Boolean(resolvedUser.bot),
      occurredAt: new Date().toISOString(),
    };

    await this.onReaction(event);
  }

  private canAcceptMessages(): boolean {
    return this.acceptingMessages && this.operatingState.isActive();
  }

  private isBotMentioned(message: Message): boolean {
    const botUserId = this.client.user?.id;
    return !!botUserId && message.mentions.users.has(botUserId);
  }

  private applyOperatingModePresence(): void {
    if (!this.client.user) return;

    this.client.user.setStatus(this.operatingState.isActive() ? "online" : "idle");
  }

  private async synchronizeCommands(readyClient: Client<true>): Promise<void> {
    await readyClient.application.commands.set([...this.interactionHandler.commands]);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (
      this.channelAccessRequester &&
      interaction.isButton?.() &&
      (await this.channelAccessRequester.handleButton(interaction))
    ) {
      return;
    }
    await this.interactionHandler.handle(interaction);
  }
}
