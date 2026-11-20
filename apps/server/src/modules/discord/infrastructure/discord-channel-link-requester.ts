import type { Logger } from "pino";

import { DiscordChannelLinkService } from "../application/discord-channel-link-service";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import {
  DISCORD_CHANNEL_LINK_BUTTON_PREFIX,
  type DiscordChannelLinkRequest,
  type PendingDiscordChannelLinkRequest,
} from "../domain/discord-channel-link-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";
import {
  DiscordApprovalRequester,
  type DiscordApprovalButtonInteraction,
  type DiscordApprovalClient,
  type DiscordApprovalMessage,
  type DiscordApprovalMessages,
} from "./discord-approval-requester";
import {
  createEphemeralTextContainerMessage,
  createTextContainerMessage,
  type DiscordContainerMessage,
  type DiscordEphemeralContainerMessage,
} from "./discord-component-message";

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
  reply(options: DiscordEphemeralContainerMessage): Promise<unknown>;
  deferReply(options: { ephemeral: boolean }): Promise<unknown>;
  editReply(options: DiscordContainerMessage): Promise<unknown>;
  deleteReply(): Promise<void>;
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

const LINK_MESSAGES: DiscordApprovalMessages<PendingDiscordChannelLinkRequest> = {
  pendingNotice: (request) => ({
    text: [
      "### 承認待ち",
      `<@${request.requesterUserId}> から、この場所を自分のチャンネルとして登録するリクエストがありました。`,
      "オーナーに確認しています。",
    ].join("\n"),
    tone: "warning",
  }),
  ownerRequest: (request, location) => ({
    text: [
      "### チャンネルの登録リクエスト",
      ...location,
      "",
      `<@${request.requesterUserId}> のチャンネルとして登録しますか？`,
    ].join("\n"),
    tone: "warning",
  }),
  decision: (request, allowed, location) => ({
    text: [
      allowed ? "### 登録しました" : "### 登録しませんでした",
      ...location,
      "",
      allowed
        ? `このチャンネルを <@${request.requesterUserId}> のチャンネルとして登録しました。`
        : `このチャンネルを <@${request.requesterUserId}> のチャンネルとして登録しませんでした。`,
    ].join("\n"),
    tone: allowed ? "success" : "danger",
  }),
  notice: (request, outcome) => linkNotice(request, outcome),
  rejection: (reason) => {
    const messages = {
      "owner-only": "この操作を実行できるのはオーナーだけです。",
      expired: "このリクエストは既に処理済みか、期限切れです。",
      "update-failed": "チャンネルのリンクを更新できませんでした。",
      conflict: "この場所は既に別のユーザーにリンクされています。",
    };
    return messages[reason];
  },
};

function linkNotice(
  request: PendingDiscordChannelLinkRequest,
  outcome: "allowed" | "denied" | "owner-unreachable",
): DiscordApprovalMessage {
  if (outcome === "owner-unreachable") {
    return {
      text: "### 確認できませんでした\nオーナーに確認できなかったため、このチャンネルは登録されませんでした。",
      tone: "danger",
    };
  }
  const user = `<@${request.requesterUserId}>`;
  return outcome === "allowed"
    ? {
        text: `### 登録されました\nこのチャンネルは ${user} のチャンネルとして登録されました。`,
        tone: "success",
      }
    : {
        text: `### 登録されませんでした\nこのチャンネルは ${user} のチャンネルとして登録されませんでした。`,
        tone: "danger",
      };
}

export interface DiscordChannelLinkRequesterDependencies {
  readonly client: DiscordApprovalClient;
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">;
  readonly linkStore: DiscordChannelLinkStore;
  readonly requestStore: Pick<
    DiscordApprovalRequestStore<PendingDiscordChannelLinkRequest>,
    "list" | "save" | "remove"
  >;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
}

export class DiscordChannelLinkRequester {
  private readonly approval: DiscordApprovalRequester<PendingDiscordChannelLinkRequest>;
  private readonly service: DiscordChannelLinkService;

  constructor(private readonly dependencies: DiscordChannelLinkRequesterDependencies) {
    this.service = new DiscordChannelLinkService({
      accessRuleStore: dependencies.accessRuleStore,
      linkStore: dependencies.linkStore,
      requestStore: dependencies.requestStore,
      ownerUserId: dependencies.ownerUserId,
      logger: dependencies.logger,
    });
    this.approval = new DiscordApprovalRequester({
      client: dependencies.client,
      service: this.service,
      messages: LINK_MESSAGES,
      buttonPrefix: DISCORD_CHANNEL_LINK_BUTTON_PREFIX,
      ownerUserId: dependencies.ownerUserId,
      logger: dependencies.logger,
    });
  }

  getLink(target: DiscordChannelLinkTarget): DiscordChannelLink | undefined {
    return this.dependencies.linkStore.getLink(target);
  }

  listLinks(guildId: string): readonly DiscordChannelLink[] {
    return this.dependencies.linkStore.listLinks(guildId);
  }

  handleButton(interaction: DiscordApprovalButtonInteraction): Promise<boolean> {
    return this.approval.handleButton(interaction);
  }

  async requestFromInteraction(interaction: DiscordChannelLinkCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!interaction.inGuild() || !guildId) {
      await interaction.reply(
        createEphemeralTextContainerMessage(
          "このコマンドはサーバー内でのみ使用できます。",
          "danger",
        ),
      );
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const location = await resolveCommandLocation(interaction, guildId);
    const existing = this.dependencies.linkStore.getLink(location.target);
    if (existing) {
      const text =
        existing.userId === interaction.user.id
          ? "この場所は既にあなたのチャンネルとして登録されています。"
          : `この場所は既に <@${existing.userId}> のチャンネルとして登録されています。解除はオーナーが /unlink で行えます。`;
      await interaction.editReply(createTextContainerMessage(text, "warning"));
      return;
    }

    const outcome = await this.service.request(
      {
        ...location.target,
        pendingChannelId: location.pendingChannelId,
        ...(location.channelName ? { channelName: location.channelName } : {}),
        requesterUserId: interaction.user.id,
      } satisfies DiscordChannelLinkRequest,
      this.approval,
    );

    switch (outcome) {
      case "requested":
        // The pending notice in the channel already tells the requester what happens next.
        await interaction.deleteReply();
        return;
      case "pending":
        await interaction.editReply(
          createTextContainerMessage("この場所の承認は既にオーナーに確認しています。", "warning"),
        );
        return;
      case "unavailable":
        await interaction.editReply(
          createTextContainerMessage("オーナーに確認できませんでした。", "danger"),
        );
        return;
    }
  }

  async unlinkFromInteraction(interaction: DiscordChannelLinkCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!interaction.inGuild() || !guildId) {
      await interaction.reply(
        createTextContainerMessage("このコマンドはサーバー内でのみ使用できます。", "danger"),
      );
      return;
    }

    if (!this.dependencies.ownerUserId || interaction.user.id !== this.dependencies.ownerUserId) {
      await interaction.reply(
        createTextContainerMessage("この操作を実行できるのはオーナーだけです。", "danger"),
      );
      return;
    }

    const location = await resolveCommandLocation(interaction, guildId);
    const result = await this.service.unlink(location.target, this.approval);
    switch (result.kind) {
      case "unlinked":
        await interaction.reply(
          createTextContainerMessage("この場所のリンクを解除しました。", "success"),
        );
        return;
      case "not-linked":
        await interaction.reply(
          createTextContainerMessage("この場所はリンクされていません。", "warning"),
        );
        return;
      case "failed":
        await interaction.reply(
          createTextContainerMessage("リンクを解除できませんでした。", "danger"),
        );
        return;
    }
  }
}

async function resolveCommandChannel(
  interaction: DiscordChannelLinkCommandInteraction,
): Promise<DiscordChannelLinkChannel | undefined> {
  if (interaction.channel) return interaction.channel;
  const fetched = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
  return isLinkChannel(fetched) ? fetched : undefined;
}

async function resolveCommandLocation(
  interaction: DiscordChannelLinkCommandInteraction,
  guildId: string,
): Promise<{
  target: DiscordChannelLinkTarget;
  pendingChannelId: string;
  channelName?: string;
}> {
  const channel = await resolveCommandChannel(interaction);
  const thread = channel?.isThread() && channel.parentId ? channel : undefined;
  return {
    target: {
      guildId,
      channelId: thread?.parentId ?? channel?.id ?? interaction.channelId,
      ...(thread ? { threadId: thread.id } : {}),
    },
    pendingChannelId: channel?.id ?? interaction.channelId,
    ...(channel?.name ? { channelName: channel.name } : {}),
  };
}
