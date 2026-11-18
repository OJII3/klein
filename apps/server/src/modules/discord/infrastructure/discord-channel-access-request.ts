import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ContainerBuilder,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import {
  DiscordChannelAccessService,
  type DiscordChannelAccessPresentation,
} from "../application/discord-channel-access-service";
import {
  createDiscordChannelAccessButtonId,
  type DiscordChannelAccessNoticeOutcome,
  type DiscordChannelAccessRejection,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordAccessRequestStore } from "../ports/discord-access-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import {
  createTextContainer,
  createTextContainerMessage,
  type DiscordContainerMessage,
  type DiscordMessageTone,
} from "./discord-component-message";

export type { DiscordChannelAccessRequest } from "../domain/discord-access-request";

const REJECTION_MESSAGES: Readonly<Record<DiscordChannelAccessRejection, string>> = {
  "owner-only": "この操作を実行できるのはオーナーだけです。",
  expired: "このリクエストは既に処理済みか、期限切れです。",
  "rule-update-failed": "アクセスルールを更新できませんでした。",
};

interface SendableTextChannel {
  send(payload: DiscordContainerMessage): Promise<Message>;
}

interface EditableMessage {
  edit(payload: DiscordContainerMessage): Promise<unknown>;
}

interface FetchableMessageChannel {
  messages: { fetch(messageId: string): Promise<Message> };
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

const NOTICE_TEXTS: Readonly<
  Record<DiscordChannelAccessNoticeOutcome, { text: string; tone: DiscordMessageTone }>
> = {
  allowed: {
    text: "### 許可されました\nこのチャンネルが許可されました。もう一度メンションしてください。",
    tone: "success",
  },
  denied: {
    text: "### 拒否されました\nこのチャンネルは許可されませんでした。",
    tone: "danger",
  },
  "owner-unreachable": {
    text: "### 確認できませんでした\nオーナーに確認できなかったため、このチャンネルでは返信できません。",
    tone: "danger",
  },
};

export interface DiscordChannelAccessClient {
  readonly channels: { fetch(id: string): Promise<unknown> };
  readonly guilds: {
    readonly cache: { get(id: string): { readonly name?: string } | undefined };
  };
  readonly users: {
    fetch(id: string): Promise<{ send(payload: DiscordContainerMessage): Promise<unknown> }>;
  };
}

export interface DiscordChannelAccessButtonInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
  update(options: DiscordContainerMessage): Promise<unknown>;
}

/**
 * Asks the owner whether a channel that the bot was mentioned in may be allowed.
 * The pending notice stays in the channel and is updated once the owner decides.
 */
export class DiscordChannelAccessRequester implements DiscordChannelAccessPresentation {
  private readonly service: DiscordChannelAccessService;

  constructor(
    private readonly client: DiscordChannelAccessClient,
    accessRuleStore: DiscordAccessRuleStore,
    accessRequestStore: DiscordAccessRequestStore,
    private readonly ownerUserId: string | undefined,
    private readonly logger?: Logger,
  ) {
    this.service = new DiscordChannelAccessService({
      accessRuleStore,
      accessRequestStore,
      ownerUserId,
      logger,
    });
  }

  request(request: DiscordChannelAccessRequest): Promise<void> {
    return this.service.request(request, this);
  }

  async handleButton(interaction: DiscordChannelAccessButtonInteraction): Promise<boolean> {
    const result = await this.service.handleButton({
      customId: interaction.customId,
      userId: interaction.user.id,
    });

    switch (result.kind) {
      case "ignored":
        return false;
      case "rejected":
        await interaction.reply({
          content: REJECTION_MESSAGES[result.reason],
          flags: MessageFlags.Ephemeral,
        });
        return true;
      case "decided": {
        const allowed = result.access === "allow";
        await interaction.update({
          components: [this.createDecisionContainer(result.request, allowed)],
          flags: MessageFlags.IsComponentsV2,
        });
        await this.updatePendingNotice(result.request, allowed ? "allowed" : "denied");
        return true;
      }
      default:
        return false;
    }
  }

  async postPendingNotice(pending: PendingDiscordAccessRequest): Promise<{ messageId?: string }> {
    const channel = await this.client.channels.fetch(pending.pendingChannelId);
    if (!isSendableTextChannel(channel)) return {};

    const message = await channel.send(
      createTextContainerMessage(
        [
          "### 承認待ち",
          `<@${pending.requesterUserId}> からのメンションを受け取りましたが、このチャンネルは許可されていません。`,
          "オーナーに確認しています。",
        ].join("\n"),
        "warning",
      ),
    );

    return { messageId: message.id };
  }

  async sendOwnerRequest(pending: PendingDiscordAccessRequest): Promise<void> {
    if (!this.ownerUserId) return;
    const owner = await this.client.users.fetch(this.ownerUserId);

    const container = createTextContainer(
      [
        "### チャンネルの許可リクエスト",
        ...this.describeLocation(pending),
        "",
        "このチャンネルを許可しますか？",
      ].join("\n"),
      "warning",
    ).addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(createDiscordChannelAccessButtonId("allow", pending.requestId))
          .setLabel("許可")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(createDiscordChannelAccessButtonId("deny", pending.requestId))
          .setLabel("拒否")
          .setStyle(ButtonStyle.Danger),
      ),
    );

    await owner.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  async updatePendingNotice(
    pending: PendingDiscordAccessRequest,
    outcome: DiscordChannelAccessNoticeOutcome,
  ): Promise<void> {
    if (!pending.pendingMessageId) return;

    try {
      const channel = await this.client.channels.fetch(pending.pendingChannelId);
      if (!hasMessageFetch(channel)) return;
      const message = await channel.messages.fetch(pending.pendingMessageId);
      if (!isEditableMessage(message)) return;
      const notice = NOTICE_TEXTS[outcome];
      await message.edit({
        components: [createTextContainer(notice.text, notice.tone)],
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

  private createDecisionContainer(
    pending: PendingDiscordAccessRequest,
    allowed: boolean,
  ): ContainerBuilder {
    return createTextContainer(
      [
        allowed ? "### 許可しました" : "### 拒否しました",
        ...this.describeLocation(pending),
        "",
        allowed ? "このチャンネルを許可しました。" : "このチャンネルは許可しませんでした。",
      ].join("\n"),
      allowed ? "success" : "danger",
    );
  }

  private describeLocation(pending: PendingDiscordAccessRequest): string[] {
    const guildName = this.client.guilds.cache.get(pending.guildId)?.name;
    const location = pending.channelName ? `#${pending.channelName}` : pending.channelId;
    const channelKind = pending.threadId ? "スレッド" : "チャンネル";
    return [
      `サーバー: ${guildName ?? pending.guildId}`,
      `${channelKind}: ${location}`,
      `リクエスト元: <@${pending.requesterUserId}>`,
    ];
  }
}
