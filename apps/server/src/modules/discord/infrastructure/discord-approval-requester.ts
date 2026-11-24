import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ContainerBuilder,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import type {
  DiscordApprovalButtonResult,
  DiscordApprovalPresentation,
  DiscordApprovalRequestOutcome,
} from "../application/discord-approval-service";
import {
  createDiscordApprovalButtonId,
  type DiscordApprovalNoticeOutcome,
  type DiscordApprovalRejection,
  type DiscordApprovalRequest,
  type DiscordApprovalRequestDraft,
} from "../domain/discord-approval-request";
import {
  createTextContainer,
  createTextContainerMessage,
  type DiscordContainerMessage,
  type DiscordMessageTone,
} from "./discord-component-message";

export interface DiscordApprovalMessage {
  readonly text: string;
  readonly tone: DiscordMessageTone;
}

export interface DiscordApprovalMessages<R extends DiscordApprovalRequest> {
  pendingNotice(request: R): DiscordApprovalMessage;
  ownerRequest(request: R, location: readonly string[]): DiscordApprovalMessage;
  decision(request: R, allowed: boolean, location: readonly string[]): DiscordApprovalMessage;
  notice(request: R, outcome: DiscordApprovalNoticeOutcome): DiscordApprovalMessage;
  rejection(reason: DiscordApprovalRejection): string;
}

export interface DiscordApprovalController<R extends DiscordApprovalRequest> {
  request(
    draft: DiscordApprovalRequestDraft<R>,
    presentation: DiscordApprovalPresentation<R>,
  ): Promise<DiscordApprovalRequestOutcome>;
  handleButton(button: {
    readonly customId: string;
    readonly userId: string;
  }): Promise<DiscordApprovalButtonResult<R>>;
  cancelPending(
    location: { readonly guildId: string; readonly channelId: string; readonly threadId?: string },
    presentation: Pick<DiscordApprovalPresentation<R>, "updatePendingNotice">,
  ): Promise<void>;
  reconcile(presentation: DiscordApprovalPresentation<R>): Promise<void>;
}

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

export interface DiscordApprovalClient {
  readonly channels: { fetch(id: string): Promise<unknown> };
  readonly guilds: {
    readonly cache: { get(id: string): { readonly name?: string } | undefined };
  };
  readonly users: {
    fetch(
      id: string,
    ): Promise<{ send(payload: DiscordContainerMessage): Promise<{ readonly id: string }> }>;
  };
}

export interface DiscordApprovalButtonInteraction {
  readonly customId: string;
  readonly user: { readonly id: string };
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
  update(options: DiscordContainerMessage): Promise<unknown>;
}

export interface DiscordApprovalRequesterDependencies<R extends DiscordApprovalRequest> {
  readonly client: DiscordApprovalClient;
  readonly service: DiscordApprovalController<R>;
  readonly messages: DiscordApprovalMessages<R>;
  readonly buttonPrefix: string;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
}

export class DiscordApprovalRequester<
  R extends DiscordApprovalRequest,
> implements DiscordApprovalPresentation<R> {
  constructor(private readonly dependencies: DiscordApprovalRequesterDependencies<R>) {}

  request(draft: DiscordApprovalRequestDraft<R>): Promise<DiscordApprovalRequestOutcome> {
    return this.dependencies.service.request(draft, this);
  }

  cancelPending(location: {
    readonly guildId: string;
    readonly channelId: string;
    readonly threadId?: string;
  }): Promise<void> {
    return this.dependencies.service.cancelPending(location, this);
  }

  reconcile(): Promise<void> {
    return this.dependencies.service.reconcile(this);
  }

  async handleButton(interaction: DiscordApprovalButtonInteraction): Promise<boolean> {
    const result = await this.dependencies.service.handleButton({
      customId: interaction.customId,
      userId: interaction.user.id,
    });

    switch (result.kind) {
      case "ignored":
        return false;
      case "rejected":
        await interaction.reply({
          content: this.dependencies.messages.rejection(result.reason),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      case "decided": {
        const allowed = result.allowed;
        await interaction.update({
          components: [this.createDecisionContainer(result.request, allowed)],
          flags: MessageFlags.IsComponentsV2,
        });
        await this.updatePendingNotice(result.request, allowed ? "allowed" : "denied");
        return true;
      }
    }

    return false;
  }

  async postPendingNotice(request: R): Promise<{ messageId?: string }> {
    const channel = await this.dependencies.client.channels.fetch(request.pendingChannelId);
    if (!isSendableTextChannel(channel)) return {};

    const notice = this.dependencies.messages.pendingNotice(request);
    const message = await channel.send(createTextContainerMessage(notice.text, notice.tone));
    return { messageId: message.id };
  }

  async sendOwnerRequest(request: R): Promise<{ messageId?: string }> {
    const ownerId = this.dependencies.ownerUserId;
    if (!ownerId) return {};
    const owner = await this.dependencies.client.users.fetch(ownerId);
    const content = this.dependencies.messages.ownerRequest(
      request,
      this.describeLocation(request),
    );

    const container = createTextContainer(content.text, content.tone).addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(this.createButtonId("allow", request.requestId))
          .setLabel("許可")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(this.createButtonId("deny", request.requestId))
          .setLabel("拒否")
          .setStyle(ButtonStyle.Danger),
      ),
    );

    const message = await owner.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    return { messageId: message.id };
  }

  async updatePendingNotice(request: R, outcome: DiscordApprovalNoticeOutcome): Promise<void> {
    if (!request.pendingMessageId) return;

    try {
      const channel = await this.dependencies.client.channels.fetch(request.pendingChannelId);
      if (!hasMessageFetch(channel)) return;
      const message = await channel.messages.fetch(request.pendingMessageId);
      if (!isEditableMessage(message)) return;
      const notice = this.dependencies.messages.notice(request, outcome);
      await message.edit({
        components: [createTextContainer(notice.text, notice.tone)],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_pending_message_update_failed",
          channelId: request.pendingChannelId,
          messageId: request.pendingMessageId,
        },
        "Failed to update the pending Discord approval message",
      );
    }
  }

  private createDecisionContainer(request: R, allowed: boolean): ContainerBuilder {
    const content = this.dependencies.messages.decision(
      request,
      allowed,
      this.describeLocation(request),
    );
    return createTextContainer(content.text, content.tone);
  }

  private createButtonId(action: "allow" | "deny", requestId: string): string {
    return createDiscordApprovalButtonId(this.dependencies.buttonPrefix, action, requestId);
  }

  private describeLocation(request: R): string[] {
    const guildName = this.dependencies.client.guilds.cache.get(request.guildId)?.name;
    const location = request.channelName ? `#${request.channelName}` : request.channelId;
    const channelKind = request.threadId ? "スレッド" : "チャンネル";
    return [
      `サーバー: ${guildName ?? request.guildId}`,
      `${channelKind}: ${location}`,
      `リクエスト元: <@${request.requesterUserId}>`,
    ];
  }
}
