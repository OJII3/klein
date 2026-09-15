import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Attachment,
  type Message,
  type ApplicationCommandDataResolvable,
  type Guild,
  type Interaction,
} from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import {
  DiscordOperatingState,
  type DiscordOperatingMode,
} from "../domain/discord-operating-state";
import {
  resolveDiscordMentions,
  type DiscordImageAttachment,
  type DiscordMessage,
  type DiscordMessageLocator,
  type DiscordReplyReference,
  type DiscordUser,
} from "../domain/discord-message";
import type { DiscordMessageHandler, DiscordService } from "../ports/discord-service";

const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_IMAGE_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DISCORD_IMAGE_FETCH_TIMEOUT_MS = 15_000;
const DISCORD_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const OPERATING_MODE_COMMANDS: readonly ApplicationCommandDataResolvable[] = [
  {
    name: "idle",
    description: "Botを一時停止します",
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    dmPermission: false,
  },
  {
    name: "online",
    description: "Botを再開します",
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    dmPermission: false,
  },
];

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

function normalizeImageMimeType(contentType: string | null): string | undefined {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const normalizedMimeType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  if (!normalizedMimeType || !DISCORD_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    return undefined;
  }

  return normalizedMimeType;
}

function hasSupportedImageAttachment(message: Message): boolean {
  return [...message.attachments.values()].some(
    (attachment) => normalizeImageMimeType(attachment.contentType) !== undefined,
  );
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > DISCORD_IMAGE_MAX_DOWNLOAD_BYTES) {
    throw new Error("Discord image attachment exceeds the download size limit");
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DISCORD_IMAGE_MAX_DOWNLOAD_BYTES) {
      throw new Error("Discord image attachment exceeds the download size limit");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > DISCORD_IMAGE_MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("Discord image attachment exceeds the download size limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function toDiscordUser(message: Message): DiscordUser {
  return {
    bot: message.author.bot,
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
  private interactionListener?: (interaction: Interaction) => void;
  private acceptingMessages = false;
  private readonly logger?: Logger;

  constructor(
    private readonly token: string,
    private readonly accessPolicy: DiscordAccessPolicy,
    logger?: Logger,
    private readonly operatingState = new DiscordOperatingState(),
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
    const [images, replyTo] = await Promise.all([
      this.fetchImages(message),
      this.fetchReplyReference(message),
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
    if (!content && !hasSupportedImageAttachment(message)) return;
    if (!isSendableChannel(message.channel)) return;

    this.channels.set(message.channelId, message.channel);

    const normalizedMessage = this.toDiscordMessage(message);

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
      this.fetchImages(message),
      this.fetchReplyReference(message),
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
    await Promise.all(
      [...readyClient.guilds.cache.values()].map((guild) => this.removeLegacyUsage(guild)),
    );
    await readyClient.application.commands.set(OPERATING_MODE_COMMANDS);
  }

  private async removeLegacyUsage(guild: Guild): Promise<void> {
    try {
      const commands = await guild.commands.fetch();
      const legacyCommands = commands.filter((command) => command.name === "usage");
      if (legacyCommands.size === 0) return;

      await Promise.all(
        [...legacyCommands.values()].map((command) => guild.commands.delete(command.id)),
      );
      this.logger?.info(
        {
          commandCount: legacyCommands.size,
          event: "discord_legacy_usage_commands_removed",
          guildId: guild.id,
        },
        "Removed legacy Discord usage commands",
      );
    } catch (error) {
      this.logger?.warn(
        { err: error, event: "discord_legacy_usage_commands_removal_failed", guildId: guild.id },
        "Failed to remove legacy Discord usage commands",
      );
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const mode =
      interaction.commandName === "idle"
        ? ("paused" as const)
        : interaction.commandName === "online"
          ? ("active" as const)
          : undefined;
    if (!mode) return;

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "このコマンドを実行する権限がありません。",
        ephemeral: true,
      });
      return;
    }

    this.setOperatingMode(mode);
    await interaction.reply({
      content: mode === "active" ? "Botを再開しました。" : "Botを一時停止しました。",
      ephemeral: true,
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
      images: [],
      parentChannelId: thread?.parentId ?? undefined,
      threadId: thread?.id,
    };
  }

  private async fetchImages(message: Message): Promise<DiscordImageAttachment[]> {
    const imageAttachments = [...message.attachments.values()].filter(
      (attachment) => normalizeImageMimeType(attachment.contentType) !== undefined,
    );

    const images = await Promise.all(
      imageAttachments.map(async (attachment) => {
        try {
          return await this.fetchImage(attachment);
        } catch (error) {
          this.logger?.warn(
            {
              attachmentId: attachment.id,
              err: error,
              event: "discord_image_attachment_fetch_failed",
              messageId: message.id,
            },
            "Failed to fetch Discord image attachment",
          );
          return undefined;
        }
      }),
    );

    return images.filter((image): image is DiscordImageAttachment => image !== undefined);
  }

  private async fetchImage(attachment: Attachment): Promise<DiscordImageAttachment> {
    const mimeType = normalizeImageMimeType(attachment.contentType);
    if (!mimeType) {
      throw new Error(`Unsupported Discord image type: ${attachment.contentType ?? "unknown"}`);
    }
    if (attachment.size > DISCORD_IMAGE_MAX_DOWNLOAD_BYTES) {
      throw new Error("Discord image attachment exceeds the download size limit");
    }

    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(DISCORD_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Discord image attachment returned HTTP ${response.status}`);
    }

    const processed = await resizeImage(await readResponseBytes(response), mimeType);
    if (!processed) {
      throw new Error("Discord image attachment could not be normalized");
    }

    return {
      data: processed.data,
      filename: attachment.name,
      id: attachment.id,
      mimeType: processed.mimeType,
    };
  }

  private normalizeMessageContent(message: Message): string {
    const content = message.content.trim();

    return resolveDiscordMentions(content, {
      user: (userId) => {
        const user = message.mentions.users.get(userId);
        if (!user) return undefined;

        return {
          bot: user.bot,
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
