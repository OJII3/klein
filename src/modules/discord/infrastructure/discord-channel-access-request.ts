import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import type { DiscordAccess } from "../domain/discord-access-policy";
import type { DiscordAccessRequestStore } from "../ports/discord-access-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";

const REQUEST_BUTTON_PREFIX = "channel-access";
const PENDING_ACCENT_COLOR = 0xfee75c;
const ALLOW_ACCENT_COLOR = 0x57f287;
const DENY_ACCENT_COLOR = 0xed4245;

interface SendableTextChannel {
  send(payload: {
    components: ContainerBuilder[];
    flags: MessageFlags.IsComponentsV2;
  }): Promise<Message>;
}

interface EditableMessage {
  edit(payload: {
    components: ContainerBuilder[];
    flags: MessageFlags.IsComponentsV2;
  }): Promise<unknown>;
}

interface FetchableMessageChannel {
  messages: { fetch(messageId: string): Promise<Message> };
}

export interface DiscordChannelAccessRequest {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
}

interface PendingAccessRequest extends DiscordChannelAccessRequest {
  readonly requestId: string;
  pendingMessageId?: string;
}

function isSendableTextChannel(value: unknown): value is SendableTextChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
}

function isEditableMessage(value: unknown): value is EditableMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "edit" in value &&
    typeof value.edit === "function"
  );
}

function hasMessageFetch(value: unknown): value is FetchableMessageChannel {
  if (typeof value !== "object" || value === null || !("messages" in value)) return false;
  const messages = value.messages;
  return (
    typeof messages === "object" &&
    messages !== null &&
    "fetch" in messages &&
    typeof messages.fetch === "function"
  );
}

function createContainer(text: string, accentColor: number): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

function createButtonId(action: "allow" | "deny", requestId: string): string {
  return `${REQUEST_BUTTON_PREFIX}:${action}:${requestId}`;
}

function parseButtonId(
  customId: string,
): { action: "allow" | "deny"; requestId: string } | undefined {
  const [prefix, action, requestId] = customId.split(":");
  if (prefix !== REQUEST_BUTTON_PREFIX || !requestId) return undefined;
  if (action !== "allow" && action !== "deny") return undefined;
  return { action, requestId };
}

function locationKey(request: DiscordChannelAccessRequest): string {
  return `${request.guildId}:${request.channelId}:${request.threadId ?? ""}`;
}

/**
 * Asks the owner whether a channel that the bot was mentioned in may be allowed.
 * The pending notice stays in the channel and is updated once the owner decides.
 */
export class DiscordChannelAccessRequester {
  private readonly pendingByLocation = new Map<string, PendingAccessRequest>();
  private readonly pendingByRequestId = new Map<string, PendingAccessRequest>();

  constructor(
    private readonly client: Client,
    private readonly accessRuleStore: DiscordAccessRuleStore,
    private readonly accessRequestStore: DiscordAccessRequestStore,
    private readonly ownerUserId: string | undefined,
    private readonly logger?: Logger,
  ) {
    for (const request of accessRequestStore.list()) {
      const pending: PendingAccessRequest = { ...request };
      this.pendingByLocation.set(locationKey(pending), pending);
      this.pendingByRequestId.set(pending.requestId, pending);
    }
  }

  async request(request: DiscordChannelAccessRequest): Promise<void> {
    if (!this.ownerUserId) return;
    const key = locationKey(request);
    if (this.pendingByLocation.has(key)) return;

    const pending: PendingAccessRequest = {
      ...request,
      requestId: randomUUID(),
    };
    this.pendingByLocation.set(key, pending);
    this.pendingByRequestId.set(pending.requestId, pending);

    try {
      const pendingMessage = await this.sendPendingMessage(pending);
      pending.pendingMessageId = pendingMessage?.id;
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_pending_message_failed",
          guildId: request.guildId,
          channelId: request.channelId,
          threadId: request.threadId,
        },
        "Failed to post the pending Discord channel access notice",
      );
    }

    try {
      await this.sendOwnerMessage(pending);
    } catch (error) {
      await this.remove(pending);
      this.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_failed",
          guildId: request.guildId,
          channelId: request.channelId,
          threadId: request.threadId,
        },
        "Failed to ask the owner about Discord channel access",
      );
      await this.updatePendingMessage(
        pending,
        "### 確認できませんでした\nオーナーに確認できなかったため、このチャンネルでは返信できません。",
        DENY_ACCENT_COLOR,
      );
      return;
    }

    await this.save(pending);
  }

  /** Returns true when the interaction was one of this requester's buttons. */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parsed = parseButtonId(interaction.customId);
    if (!parsed) return false;

    if (!this.ownerUserId || interaction.user.id !== this.ownerUserId) {
      await interaction.reply({
        content: "この操作を実行できるのはオーナーだけです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const pending = this.pendingByRequestId.get(parsed.requestId);
    if (!pending) {
      await interaction.reply({
        content: "このリクエストは既に処理済みか、期限切れです。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const access: DiscordAccess = parsed.action === "allow" ? "allow" : "deny";
    try {
      await this.accessRuleStore.setAccess(
        {
          guildId: pending.guildId,
          channelId: pending.channelId,
          ...(pending.threadId ? { threadId: pending.threadId } : {}),
        },
        access,
      );
    } catch (error) {
      this.logger?.error(
        {
          err: error,
          event: "discord_channel_access_update_failed",
          guildId: pending.guildId,
          channelId: pending.channelId,
          threadId: pending.threadId,
        },
        "Failed to update Discord channel access",
      );
      await interaction.reply({
        content: "アクセスルールを更新できませんでした。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await this.remove(pending);

    const allowed = access === "allow";
    await interaction.update({
      components: [
        createContainer(
          allowed
            ? "### 許可しました\nこのチャンネルを許可しました。"
            : "### 拒否しました\nこのチャンネルは許可しませんでした。",
          allowed ? ALLOW_ACCENT_COLOR : DENY_ACCENT_COLOR,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
    await this.updatePendingMessage(
      pending,
      allowed
        ? "### 許可されました\nこのチャンネルが許可されました。もう一度メンションしてください。"
        : "### 拒否されました\nこのチャンネルは許可されませんでした。",
      allowed ? ALLOW_ACCENT_COLOR : DENY_ACCENT_COLOR,
    );
    return true;
  }

  private async sendPendingMessage(pending: PendingAccessRequest): Promise<Message | undefined> {
    const channel = await this.client.channels.fetch(pending.pendingChannelId);
    if (!isSendableTextChannel(channel)) return undefined;

    return channel.send({
      components: [
        createContainer(
          [
            "### 承認待ち",
            `<@${pending.requesterUserId}> からのメンションを受け取りましたが、このチャンネルは許可されていません。`,
            "オーナーに確認しています。",
          ].join("\n"),
          PENDING_ACCENT_COLOR,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  private async sendOwnerMessage(pending: PendingAccessRequest): Promise<void> {
    if (!this.ownerUserId) return;
    const owner = await this.client.users.fetch(this.ownerUserId);
    const guildName = this.client.guilds.cache.get(pending.guildId)?.name;
    const location = pending.channelName ? `#${pending.channelName}` : pending.channelId;
    const channelKind = pending.threadId ? "スレッド" : "チャンネル";

    await owner.send({
      components: [
        createContainer(
          [
            "### チャンネルの許可リクエスト",
            `サーバー: ${guildName ?? pending.guildId}`,
            `${channelKind}: ${location}`,
            `リクエスト元: <@${pending.requesterUserId}>`,
            "",
            "このチャンネルを許可しますか？",
          ].join("\n"),
          PENDING_ACCENT_COLOR,
        ).addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(createButtonId("allow", pending.requestId))
              .setLabel("許可")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(createButtonId("deny", pending.requestId))
              .setLabel("拒否")
              .setStyle(ButtonStyle.Danger),
          ),
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  private async updatePendingMessage(
    pending: PendingAccessRequest,
    text: string,
    accentColor: number,
  ): Promise<void> {
    if (!pending.pendingMessageId) return;
    try {
      const channel = await this.client.channels.fetch(pending.pendingChannelId);
      if (!hasMessageFetch(channel)) return;
      const message = await channel.messages.fetch(pending.pendingMessageId);
      if (!isEditableMessage(message)) return;
      await message.edit({
        components: [createContainer(text, accentColor)],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_pending_message_update_failed",
          channelId: pending.pendingChannelId,
          messageId: pending.pendingMessageId,
        },
        "Failed to update the pending Discord channel access message",
      );
    }
  }

  private async save(pending: PendingAccessRequest): Promise<void> {
    try {
      await this.accessRequestStore.save(pending);
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_persist_failed",
          requestId: pending.requestId,
        },
        "Failed to persist a Discord channel access request",
      );
    }
  }

  private async remove(pending: PendingAccessRequest): Promise<void> {
    this.forget(pending);
    try {
      await this.accessRequestStore.remove(pending.requestId);
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_remove_failed",
          requestId: pending.requestId,
        },
        "Failed to remove a persisted Discord channel access request",
      );
    }
  }

  private forget(pending: PendingAccessRequest): void {
    this.pendingByLocation.delete(locationKey(pending));
    this.pendingByRequestId.delete(pending.requestId);
  }
}
