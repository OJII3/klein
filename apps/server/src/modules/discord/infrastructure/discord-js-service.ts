import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  type ApplicationCommandDataResolvable,
  type ClientOptions,
} from "discord.js";
import type { Logger } from "pino";

import { DiscordMessageIngest } from "../application/discord-message-ingest";
import { DiscordReactionIngest } from "../application/discord-reaction-ingest";
import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordChoiceRequest } from "../domain/discord-choice";
import { isValidDiscordUserId } from "../domain/discord-user";
import type { DiscordUserProfile } from "../domain/discord-user-profile";
import {
  DiscordOperatingState,
  type DiscordOperatingMode,
} from "../domain/discord-operating-state";
import {
  type DiscordChannelHistoryMessage,
  type DiscordChannelHistoryPageRequest,
  type DiscordMessage,
  type DiscordMessageLocator,
} from "../domain/discord-message";
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
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";
import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";
import type { DiscordUserProfileReader } from "../ports/discord-user-profile-reader";
import type { PendingDiscordChannelLinkRequest } from "../domain/discord-channel-link-request";
import type {
  SecretRequestIntake,
  SecretRequestLifecycle,
  SecretRequestOutcome,
} from "../../secrets/application/secret-service";
import type { SecretRequestDraft } from "../../secrets/domain/secret-request";
import {
  DiscordSecretRequester,
  type DiscordSecretButtonInteraction,
} from "../../secrets/infrastructure/discord-secret-requester";

import {
  DiscordChannelAccessRequester,
  type DiscordChannelAccessButtonInteraction,
  type DiscordChannelAccessClient,
} from "./discord-channel-access-request";
import { DiscordChannelLinkRequester } from "./discord-channel-link-requester";
import type { DiscordContainerMessage } from "./discord-component-message";
import {
  DiscordChoiceRequester,
  type DiscordChoiceButtonInteraction,
  type DiscordChoiceClient,
} from "./discord-choice-requester";
import {
  DiscordVoiceChatController,
  type DiscordVoiceChatControllerOptions,
} from "./discord-voice-chat-controller";
import {
  DiscordJsInteractionHandler,
  type DiscordHandlerInteraction,
} from "./discord-js-interaction-handler";
import { DiscordJsMessageAdapter, type DiscordAdapterMessage } from "./discord-js-message-adapter";
import {
  toDiscordUserProfile,
  type DiscordServiceProfileGuild,
  type DiscordServiceProfileGuildMember,
  type DiscordServiceProfileUser,
} from "./discord-js-user-profile";

const DISCORD_MESSAGE_LIMIT = 2_000;
interface SendableChannel {
  send(content: string | { files: AttachmentBuilder[] }): Promise<unknown>;
  sendTyping?(): Promise<void>;
}

export type DiscordServiceMessage = DiscordAdapterMessage;

export interface DiscordServiceTextChannel {
  readonly id: string;
  readonly name?: string | null;
  readonly guildId?: string | null;
  readonly parentId?: string | null;
  readonly messages?: { fetch(messageId: string): Promise<DiscordServiceMessage> };
  isThread(): boolean;
  isTextBased(): boolean;
}

export interface DiscordServiceMessageChannel extends DiscordServiceTextChannel {
  readonly messages: { fetch(messageId: string): Promise<DiscordServiceMessage> };
}

export interface DiscordServiceMessagePageOptions {
  readonly limit: number;
  readonly before?: string;
  readonly after?: string;
}

interface DiscordServiceMessagePageChannel extends DiscordServiceTextChannel {
  readonly messages: {
    fetch(messageId: string): Promise<DiscordServiceMessage>;
    fetch(
      options: DiscordServiceMessagePageOptions,
    ): Promise<ReadonlyMap<string, DiscordServiceMessage>>;
  };
}

export interface DiscordServiceChannel {
  readonly id?: string;
  readonly name?: string | null;
  readonly guildId?: string | null;
  readonly parentId?: string | null;
  readonly messages?: { fetch(messageId: string): Promise<DiscordServiceMessage> };
  isThread?(): boolean;
  isTextBased(): boolean;
}

export interface DiscordServiceResolvedUser {
  readonly partial?: false;
  readonly id: string;
  readonly bot: boolean;
}

export type DiscordServiceUser =
  | DiscordServiceResolvedUser
  | { readonly partial: true; fetch(): Promise<DiscordServiceResolvedUser> };

export interface DiscordServiceResolvedReactionMessage {
  readonly partial?: false;
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly content: string | null;
  readonly author: { readonly id: string } | null;
  readonly channel: {
    readonly id?: string;
    readonly name?: string | null;
    readonly parentId?: string | null;
    isThread?(): boolean;
  };
}

export type DiscordServiceReactionMessage =
  | DiscordServiceResolvedReactionMessage
  | { readonly partial: true; fetch(): Promise<DiscordServiceResolvedReactionMessage> };

export interface DiscordServiceResolvedReaction {
  readonly partial?: false;
  readonly emoji: { readonly name: string | null; readonly identifier: string };
  readonly message: DiscordServiceReactionMessage;
}

export type DiscordServiceReaction =
  | DiscordServiceResolvedReaction
  | { readonly partial: true; fetch(): Promise<DiscordServiceResolvedReaction> };

export type DiscordServiceButtonInteraction = DiscordChoiceButtonInteraction &
  DiscordChannelAccessButtonInteraction & {
    isButton?(): boolean;
    isChatInputCommand(): boolean;
    isModalSubmit(): boolean;
  };

export type DiscordServiceInteraction = DiscordServiceButtonInteraction | DiscordHandlerInteraction;

export interface DiscordServiceReadyClient {
  readonly user: { readonly id: string };
  readonly application: {
    readonly commands: {
      set(commands: readonly ApplicationCommandDataResolvable[]): Promise<unknown>;
    };
  };
}

export type DiscordServiceSendableUser = DiscordServiceProfileUser & {
  send(payload: DiscordContainerMessage): Promise<unknown>;
};

export interface DiscordServiceClient extends DiscordChoiceClient, DiscordChannelAccessClient {
  readonly user: {
    readonly id: string;
    setActivity(name: string): unknown;
    setStatus(status: "online" | "idle"): unknown;
  } | null;
  readonly channels: {
    fetch(id: string): Promise<DiscordServiceChannel | null>;
  };
  readonly guilds: {
    readonly cache: ReadonlyMap<string, { readonly name?: string }>;
    fetch(id: string): Promise<DiscordServiceProfileGuild>;
  };
  readonly users: {
    fetch(id: string, options?: { readonly force?: boolean }): Promise<DiscordServiceSendableUser>;
  };
  once(
    event: Events.ClientReady,
    listener: (readyClient: DiscordServiceReadyClient) => void,
  ): unknown;
  on(event: Events.MessageCreate, listener: (message: DiscordServiceMessage) => void): unknown;
  on(
    event: Events.MessageReactionAdd,
    listener: (reaction: DiscordServiceReaction, user: DiscordServiceUser) => void,
  ): unknown;
  on(
    event: Events.InteractionCreate,
    listener: (interaction: DiscordServiceInteraction) => void,
  ): unknown;
  off(event: Events.MessageCreate, listener: (message: DiscordServiceMessage) => void): unknown;
  off(
    event: Events.MessageReactionAdd,
    listener: (reaction: DiscordServiceReaction, user: DiscordServiceUser) => void,
  ): unknown;
  off(
    event: Events.InteractionCreate,
    listener: (interaction: DiscordServiceInteraction) => void,
  ): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown>;
}

function isTextBasedChannel(
  channel: DiscordServiceChannel | null | undefined,
): channel is DiscordServiceTextChannel {
  return (
    channel !== null &&
    channel !== undefined &&
    channel.isTextBased() &&
    typeof channel.id === "string" &&
    typeof channel.isThread === "function"
  );
}

function isReadableChannel(
  channel: DiscordServiceChannel | null | undefined,
): channel is DiscordServiceMessageChannel {
  return isTextBasedChannel(channel) && channel.messages !== undefined;
}

function isMessagePageChannel(
  channel: DiscordServiceMessageChannel,
): channel is DiscordServiceMessagePageChannel {
  // discord.js MessageManager.fetch also accepts { limit, before, after } page options.
  return typeof channel.messages.fetch === "function";
}

function isButtonInteraction(
  interaction: DiscordServiceInteraction,
): interaction is DiscordServiceButtonInteraction {
  return (
    "isButton" in interaction &&
    typeof interaction.isButton === "function" &&
    interaction.isButton() &&
    "customId" in interaction &&
    "update" in interaction
  );
}

function isSecretButtonInteraction(
  interaction: DiscordServiceInteraction,
): interaction is DiscordServiceButtonInteraction & DiscordSecretButtonInteraction {
  return (
    isButtonInteraction(interaction) &&
    "showModal" in interaction &&
    typeof interaction.showModal === "function"
  );
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

export class DiscordJsService
  implements DiscordGateway, DiscordChannelApi, DiscordUserProfileReader, SecretRequestIntake
{
  private readonly client: DiscordServiceClient;
  private readonly channels = new Map<string, SendableChannel>();
  private readonly voiceChatController?: DiscordVoiceChatController;
  private readonly interactionHandler: DiscordJsInteractionHandler;
  private readonly messageAdapter: DiscordJsMessageAdapter;
  private readonly messageIngest: DiscordMessageIngest;
  private readonly reactionIngest: DiscordReactionIngest;
  private readonly channelAccessRequester?: DiscordChannelAccessRequester;
  private readonly channelLinkRequester?: DiscordChannelLinkRequester;
  private readonly secretRequester?: DiscordSecretRequester;
  private readonly choiceRequester: DiscordChoiceRequester;
  private readonly pendingTasks = new Set<Promise<void>>();
  private onMessage?: DiscordMessageHandler;
  private onReaction?: DiscordReactionHandler;
  private messageListener?: (message: DiscordServiceMessage) => void;
  private reactionListener?: (reaction: DiscordServiceReaction, user: DiscordServiceUser) => void;
  private interactionListener?: (interaction: DiscordServiceInteraction) => void;
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
    options?: {
      readonly enableReactions?: boolean;
      readonly createClient?: (clientOptions: ClientOptions) => DiscordServiceClient;
      readonly channelLinkStore?: DiscordChannelLinkStore;
      readonly channelLinkRequestStore?: Pick<
        DiscordApprovalRequestStore<PendingDiscordChannelLinkRequest>,
        "list" | "save" | "remove"
      >;
      readonly secrets?: SecretRequestLifecycle;
    },
  ) {
    this.logger = logger?.child({ component: "discord-service" });
    this.messageAdapter = new DiscordJsMessageAdapter(this.logger);
    this.voiceChatController = voiceChat
      ? new DiscordVoiceChatController(accessPolicy, logger, voiceChat)
      : undefined;
    const enableReactions = options?.enableReactions === true;
    const clientOptions: ClientOptions = {
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        ...(enableReactions
          ? [GatewayIntentBits.DirectMessageReactions, GatewayIntentBits.GuildMessageReactions]
          : []),
        ...(this.voiceChatController ? [GatewayIntentBits.GuildVoiceStates] : []),
      ],
      partials: [
        Partials.Channel,
        ...(enableReactions ? [Partials.Message, Partials.Reaction, Partials.User] : []),
      ],
    };
    this.client = options?.createClient?.(clientOptions) ?? new Client(clientOptions);
    this.choiceRequester = new DiscordChoiceRequester(
      this.client,
      accessPolicy,
      (message) => this.onMessage?.(message) ?? Promise.resolve(),
      this.logger,
    );
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
    this.channelLinkRequester =
      accessRuleStore && options?.channelLinkStore && options.channelLinkRequestStore
        ? new DiscordChannelLinkRequester({
            client: this.client,
            accessRuleStore,
            linkStore: options.channelLinkStore,
            requestStore: options.channelLinkRequestStore,
            ownerUserId,
            logger: this.logger,
          })
        : undefined;
    this.secretRequester = options?.secrets
      ? new DiscordSecretRequester({
          client: this.client,
          service: options.secrets,
          logger: this.logger,
        })
      : undefined;
    this.interactionHandler = new DiscordJsInteractionHandler(
      accessPolicy,
      (mode) => this.setOperatingMode(mode),
      this.voiceChatController,
      channelRuleStore,
      accessRuleStore,
      this.channelLinkRequester,
      this.secretRequester,
    );
    this.messageIngest = new DiscordMessageIngest({
      accessPolicy,
      reader: this.messageAdapter,
      selfUserId: () => this.client.user?.id,
      canAccept: () => this.canAcceptMessages(),
      onMessage: async (message) => {
        await this.onMessage?.(message);
      },
      requestAccess: async (request) => {
        await this.channelAccessRequester?.request(request);
      },
    });
    this.reactionIngest = new DiscordReactionIngest({
      accessPolicy,
      selfUserId: () => this.client.user?.id,
      canAccept: () => this.canAcceptMessages(),
      onReaction: async (event) => {
        await this.onReaction?.(event);
      },
    });
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
      this.trackPending(this.synchronizeCommandsSafely(readyClient));
    });
    this.messageListener = (message) => {
      this.trackPending(
        this.handleMessage(message).catch((error: unknown) => {
          this.logger?.error(
            { err: error, event: "discord_message_handler_failed" },
            "Failed to handle Discord message",
          );
        }),
      );
    };
    this.client.on(Events.MessageCreate, this.messageListener);
    if (onReaction) {
      this.reactionListener = (reaction, user) => {
        this.trackPending(
          this.handleReactionAdd(reaction, user).catch((error: unknown) => {
            this.logger?.error(
              { err: error, event: "discord_reaction_handler_failed" },
              "Failed to handle Discord message reaction",
            );
          }),
        );
      };
      this.client.on(Events.MessageReactionAdd, this.reactionListener);
    }
    this.interactionListener = (interaction) => {
      this.trackPending(
        this.handleInteraction(interaction).catch((error: unknown) => {
          this.logger?.error(
            { err: error, event: "discord_interaction_handler_failed" },
            "Failed to handle Discord interaction",
          );
        }),
      );
    };
    this.client.on(Events.InteractionCreate, this.interactionListener);
    await this.client.login(this.token);
  }

  requestSecret(draft: SecretRequestDraft): Promise<SecretRequestOutcome> {
    if (!this.secretRequester) return Promise.resolve({ kind: "unavailable" });
    return this.secretRequester.requestSecret(draft);
  }

  async flush(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.all(this.pendingTasks);
    }
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

  listGuildNames(): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const [guildId, guild] of this.client.guilds.cache) {
      if (guild.name) names.set(guildId, guild.name);
    }
    return names;
  }

  async getChannelLocation(channelId: string): Promise<DiscordChannelLocation> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isTextBasedChannel(channel)) {
      throw new Error(`Discord channel cannot contain messages: ${channelId}`);
    }
    const thread = channel.isThread() ? channel : undefined;
    const channelName = "name" in channel && typeof channel.name === "string" ? channel.name : "";
    return {
      guildId: "guildId" in channel ? (channel.guildId ?? undefined) : undefined,
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

  sendChoices(channelId: string, request: DiscordChoiceRequest): Promise<string> {
    return this.choiceRequester.send(channelId, request);
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
    if (!isReadableChannel(channel)) {
      throw new Error(`Discord channel cannot contain messages: ${locator.channelId}`);
    }

    const thread = channel.isThread() ? channel : undefined;
    if (
      !this.accessPolicy.canReceive({
        guildId: "guildId" in channel ? (channel.guildId ?? undefined) : undefined,
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

  async readMessages(
    request: DiscordChannelHistoryPageRequest,
    requester?: DiscordMessageRequester,
  ): Promise<readonly DiscordChannelHistoryMessage[]> {
    const channel = await this.getReadableChannelForHistory(request.channelId, requester);
    if (!isMessagePageChannel(channel)) {
      throw new Error(`Discord channel cannot contain messages: ${request.channelId}`);
    }
    const messages = await channel.messages.fetch({
      limit: request.limit,
      ...(request.before ? { before: request.before } : {}),
      ...(request.after ? { after: request.after } : {}),
    });

    return [...messages.values()].map((message) =>
      this.messageAdapter.toDiscordChannelHistoryMessage(message),
    );
  }

  async readUserProfile(userId: string, guildId?: string): Promise<DiscordUserProfile | undefined> {
    if (!isValidDiscordUserId(userId)) return undefined;

    let user: DiscordServiceProfileUser;
    try {
      user = await this.client.users.fetch(userId, { force: true });
    } catch (error) {
      this.logger?.warn(
        { err: error, event: "discord_user_profile_fetch_failed", userId },
        "Failed to fetch Discord user profile",
      );
      return undefined;
    }

    const membership = guildId ? await this.fetchGuildMembership(userId, guildId) : undefined;
    return toDiscordUserProfile({ user, ...membership });
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
    this.choiceRequester.clear();
    this.channels.clear();
    await this.voiceChatController?.stop();
    await this.client.destroy();
  }

  private async getReadableChannelForHistory(
    channelId: string,
    requester?: DiscordMessageRequester,
  ): Promise<DiscordServiceMessageChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isReadableChannel(channel)) {
      throw new Error(`Discord channel cannot contain messages: ${channelId}`);
    }

    const thread = channel.isThread() ? channel : undefined;
    if (
      !this.accessPolicy.canReceive({
        guildId: "guildId" in channel ? (channel.guildId ?? undefined) : undefined,
        channelId: thread?.parentId ?? channel.id,
        threadId: thread?.id,
        ...requester,
      })
    ) {
      throw new Error(`Discord channel access denied: ${channelId}`);
    }

    return channel;
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

  private async fetchGuildMembership(
    userId: string,
    guildId: string,
  ): Promise<
    | {
        readonly guild: DiscordServiceProfileGuild;
        readonly member: DiscordServiceProfileGuildMember;
      }
    | undefined
  > {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return { guild, member };
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_guild_member_profile_fetch_failed",
          guildId,
          userId,
        },
        "Failed to fetch Discord guild member profile",
      );
      return undefined;
    }
  }

  private async handleMessage(message: DiscordServiceMessage): Promise<void> {
    if (!isSendableChannel(message.channel)) return;
    this.channels.set(message.channelId, message.channel);
    await this.messageIngest.handle(message);
  }

  private async handleReactionAdd(
    reaction: DiscordServiceReaction,
    user: DiscordServiceUser,
  ): Promise<void> {
    if (!this.canAcceptMessages() || !this.onReaction) return;

    const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction;
    const resolvedMessage = resolvedReaction.message.partial
      ? await resolvedReaction.message.fetch()
      : resolvedReaction.message;
    const resolvedUser = user.partial ? await user.fetch() : user;

    if (!this.canAcceptMessages()) return;

    const channel = resolvedMessage.channel;
    const thread = channel?.isThread?.() ? channel : undefined;
    const channelName =
      channel && "name" in channel && typeof channel.name === "string" && channel.name
        ? channel.name
        : undefined;

    await this.reactionIngest.handle({
      message: {
        id: resolvedMessage.id,
        channelId: resolvedMessage.channelId,
        ...(resolvedMessage.guildId ? { guildId: resolvedMessage.guildId } : {}),
        ...(typeof resolvedMessage.content === "string" && resolvedMessage.content.length > 0
          ? { content: resolvedMessage.content }
          : {}),
        ...(resolvedMessage.author?.id ? { authorId: resolvedMessage.author.id } : {}),
        ...(channel
          ? {
              channel: {
                ...(channel.id ? { id: channel.id } : {}),
                ...(channelName ? { name: channelName } : {}),
                ...(channel.parentId ? { parentId: channel.parentId } : {}),
                isThread: thread !== undefined,
              },
            }
          : {}),
      },
      emojiName: resolvedReaction.emoji.name,
      emojiIdentifier: resolvedReaction.emoji.identifier,
      userId: resolvedUser.id,
      userIsBot: resolvedUser.bot,
    });
  }

  private canAcceptMessages(): boolean {
    return this.acceptingMessages && this.operatingState.isActive();
  }

  private applyOperatingModePresence(): void {
    if (!this.client.user) return;

    this.client.user.setStatus(this.operatingState.isActive() ? "online" : "idle");
  }

  private trackPending(task: Promise<void>): void {
    const tracked = task.finally(() => {
      this.pendingTasks.delete(tracked);
    });
    this.pendingTasks.add(tracked);
  }

  private async synchronizeCommandsSafely(readyClient: DiscordServiceReadyClient): Promise<void> {
    try {
      await this.synchronizeCommands(readyClient);
      this.logger?.info(
        { event: "discord_commands_synchronized" },
        "Synchronized Discord commands",
      );
    } catch (error) {
      this.logger?.error(
        { err: error, event: "discord_commands_synchronization_failed" },
        "Failed to synchronize Discord commands",
      );
    }
  }

  private async synchronizeCommands(readyClient: DiscordServiceReadyClient): Promise<void> {
    await readyClient.application.commands.set([...this.interactionHandler.commands]);
  }

  private async handleInteraction(interaction: DiscordServiceInteraction): Promise<void> {
    if (
      this.secretRequester &&
      isSecretButtonInteraction(interaction) &&
      (await this.secretRequester.handleButton(interaction))
    ) {
      return;
    }
    if (
      isButtonInteraction(interaction) &&
      (await this.choiceRequester.handleButton(interaction))
    ) {
      return;
    }
    if (
      this.channelAccessRequester &&
      isButtonInteraction(interaction) &&
      (await this.channelAccessRequester.handleButton(interaction))
    ) {
      return;
    }
    if (
      this.channelLinkRequester &&
      isButtonInteraction(interaction) &&
      (await this.channelLinkRequester.handleButton(interaction))
    ) {
      return;
    }
    await this.interactionHandler.handle(interaction);
  }
}
