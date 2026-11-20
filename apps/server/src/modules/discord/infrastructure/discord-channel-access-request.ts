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
  type DiscordChannelAccessRequestOutcome,
} from "../application/discord-channel-access-service";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import {
  createDiscordChannelAccessButtonId,
  type DiscordChannelAccessNoticeOutcome,
  type DiscordChannelAccessRejection,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordAccessRequestStore } from "../ports/discord-access-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";
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
  "link-update-failed": "チャンネルの登録を保存できませんでした。",
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

function noticeFor(
  pending: PendingDiscordAccessRequest,
  outcome: DiscordChannelAccessNoticeOutcome,
): { text: string; tone: DiscordMessageTone } {
  if (!pending.linkUserId) return NOTICE_TEXTS[outcome];

  const linkNotices: Record<
    DiscordChannelAccessNoticeOutcome,
    { text: string; tone: DiscordMessageTone }
  > = {
    allowed: {
      text: `### 登録されました\nこのチャンネルは <@${pending.linkUserId}> のチャンネルとして登録されました。`,
      tone: "success",
    },
    denied: {
      text: `### 登録されませんでした\nこのチャンネルは <@${pending.linkUserId}> のチャンネルとして登録されませんでした。`,
      tone: "danger",
    },
    "owner-unreachable": {
      text: "### 確認できませんでした\nオーナーに確認できなかったため、このチャンネルは登録されませんでした。",
      tone: "danger",
    },
  };

  return linkNotices[outcome];
}

const REQUEST_OUTCOME_MESSAGES: Readonly<
  Record<
    Exclude<DiscordChannelAccessRequestOutcome["kind"], "requested">,
    { text: string; tone: DiscordMessageTone }
  >
> = {
  pending: { text: "この場所の承認は既にオーナーに確認しています。", tone: "warning" },
  "already-linked": {
    text: "この場所は既にあなたのチャンネルとして登録されています。",
    tone: "neutral",
  },
  unavailable: { text: "オーナーに確認できませんでした。", tone: "danger" },
};

export interface DiscordChannelLinkChannel {
  readonly id: string;
  readonly name?: string | null;
  readonly parentId?: string | null;
  isThread(): boolean;
}

export interface DiscordChannelLinkCommandInteraction {
  readonly guildId: string | null;
  readonly channelId: string;
  readonly user: { readonly id: string; readonly bot: boolean };
  readonly channel: DiscordChannelLinkChannel | null;
  readonly client: { readonly channels: { fetch(id: string): Promise<unknown> } };
  inGuild(): boolean;
  reply(options: DiscordContainerMessage): Promise<unknown>;
}

function isLinkChannel(value: unknown): value is DiscordChannelLinkChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "isThread" in value &&
    typeof value.isThread === "function"
  );
}

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
    private readonly channelLinkStore?: DiscordChannelLinkStore,
    private readonly logger?: Logger,
  ) {
    this.service = new DiscordChannelAccessService({
      accessRuleStore,
      accessRequestStore,
      ...(channelLinkStore ? { channelLinkStore } : {}),
      ownerUserId,
      logger,
    });
  }

  request(request: DiscordChannelAccessRequest): Promise<DiscordChannelAccessRequestOutcome> {
    return this.service.request(request, this);
  }

  getLink(target: DiscordChannelLinkTarget): DiscordChannelLink | undefined {
    return this.channelLinkStore?.getLink(target);
  }

  async requestFromInteraction(interaction: DiscordChannelLinkCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply(
        createTextContainerMessage("このコマンドはサーバー内でのみ使用できます。", "danger"),
      );
      return;
    }

    const channel = await this.resolveCommandChannel(interaction);
    const thread = channel?.isThread() && channel.parentId ? channel : undefined;
    const outcome = await this.service.request(
      {
        guildId: interaction.guildId,
        channelId: thread?.parentId ?? channel?.id ?? interaction.channelId,
        ...(thread ? { threadId: thread.id } : {}),
        pendingChannelId: channel?.id ?? interaction.channelId,
        ...(channel?.name ? { channelName: channel.name } : {}),
        requesterUserId: interaction.user.id,
        linkUserId: interaction.user.id,
      },
      this,
    );

    if (outcome.kind === "requested") {
      await interaction.reply(
        createTextContainerMessage(
          "オーナーに確認しています。承認されると、この場所はあなたのチャンネルとして登録されます。",
          "warning",
        ),
      );
      return;
    }

    const message = REQUEST_OUTCOME_MESSAGES[outcome.kind];
    await interaction.reply(createTextContainerMessage(message.text, message.tone));
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

    const text = pending.linkUserId
      ? [
          "### 承認待ち",
          `<@${pending.linkUserId}> から、この場所を自分のチャンネルとして登録するリクエストがありました。`,
          "オーナーに確認しています。",
        ].join("\n")
      : [
          "### 承認待ち",
          `<@${pending.requesterUserId}> からのメンションを受け取りましたが、このチャンネルは許可されていません。`,
          "オーナーに確認しています。",
        ].join("\n");
    const message = await channel.send(createTextContainerMessage(text, "warning"));

    return { messageId: message.id };
  }

  async sendOwnerRequest(pending: PendingDiscordAccessRequest): Promise<void> {
    if (!this.ownerUserId) return;
    const owner = await this.client.users.fetch(this.ownerUserId);

    const lines = [
      pending.linkUserId ? "### チャンネルの登録リクエスト" : "### チャンネルの許可リクエスト",
      ...this.describeLocation(pending),
    ];
    if (pending.linkUserId) {
      const currentOwnerId = this.channelLinkStore?.getLink(pending)?.userId;
      if (currentOwnerId && currentOwnerId !== pending.linkUserId) {
        lines.push(`現在の登録: <@${currentOwnerId}>`);
      }
      lines.push("", `<@${pending.linkUserId}> のチャンネルとして登録しますか？`);
    } else {
      lines.push("", "このチャンネルを許可しますか？");
    }

    const container = createTextContainer(lines.join("\n"), "warning").addActionRowComponents(
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
      const notice = noticeFor(pending, outcome);
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
    const lines = [
      pending.linkUserId
        ? allowed
          ? "### 登録しました"
          : "### 登録しませんでした"
        : allowed
          ? "### 許可しました"
          : "### 拒否しました",
      ...this.describeLocation(pending),
      "",
      pending.linkUserId
        ? allowed
          ? `このチャンネルを <@${pending.linkUserId}> のチャンネルとして登録しました。`
          : `このチャンネルを <@${pending.linkUserId}> のチャンネルとして登録しませんでした。`
        : allowed
          ? "このチャンネルを許可しました。"
          : "このチャンネルは許可しませんでした。",
    ];

    return createTextContainer(lines.join("\n"), allowed ? "success" : "danger");
  }

  private async resolveCommandChannel(
    interaction: DiscordChannelLinkCommandInteraction,
  ): Promise<DiscordChannelLinkChannel | undefined> {
    if (interaction.channel) return interaction.channel;
    const fetched = await interaction.client.channels
      .fetch(interaction.channelId)
      .catch(() => null);
    return isLinkChannel(fetched) ? fetched : undefined;
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
