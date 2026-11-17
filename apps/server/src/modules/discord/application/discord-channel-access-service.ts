import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { DiscordAccess } from "../domain/discord-access-policy";
import {
  discordChannelAccessRequestLocationKey,
  parseDiscordChannelAccessButtonId,
  type DiscordChannelAccessNoticeOutcome,
  type DiscordChannelAccessRejection,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordAccessRequestStore } from "../ports/discord-access-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";

/** Renders the pending notice and the owner's approval request. */
export interface DiscordChannelAccessPresentation {
  postPendingNotice(request: PendingDiscordAccessRequest): Promise<{ messageId?: string }>;
  sendOwnerRequest(request: PendingDiscordAccessRequest): Promise<void>;
  updatePendingNotice(
    request: PendingDiscordAccessRequest,
    outcome: DiscordChannelAccessNoticeOutcome,
  ): Promise<void>;
}

export type DiscordChannelAccessButtonResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: DiscordChannelAccessRejection }
  | {
      readonly kind: "decided";
      readonly request: PendingDiscordAccessRequest;
      readonly access: DiscordAccess;
    };

export interface DiscordChannelAccessServiceDependencies {
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">;
  readonly accessRequestStore: Pick<DiscordAccessRequestStore, "list" | "save" | "remove">;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
}

/**
 * Tracks channel access requests and lets only the owner decide them. Posting
 * and updating the messages stays behind {@link DiscordChannelAccessPresentation}.
 */
export class DiscordChannelAccessService {
  private readonly pendingByLocation = new Map<string, PendingDiscordAccessRequest>();
  private readonly pendingByRequestId = new Map<string, PendingDiscordAccessRequest>();

  constructor(private readonly dependencies: DiscordChannelAccessServiceDependencies) {
    for (const request of dependencies.accessRequestStore.list()) {
      this.remember(request);
    }
  }

  async request(
    request: DiscordChannelAccessRequest,
    presentation: DiscordChannelAccessPresentation,
  ): Promise<void> {
    if (!this.dependencies.ownerUserId) return;

    const key = discordChannelAccessRequestLocationKey(request);
    if (this.pendingByLocation.has(key)) return;

    let pending: PendingDiscordAccessRequest = {
      ...request,
      requestId: randomUUID(),
    };
    this.remember(pending);

    try {
      const { messageId } = await presentation.postPendingNotice(pending);
      if (messageId) {
        pending = { ...pending, pendingMessageId: messageId };
        this.remember(pending);
      }
    } catch (error) {
      this.dependencies.logger?.warn(
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
      await presentation.sendOwnerRequest(pending);
    } catch (error) {
      await this.remove(pending);
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_failed",
          guildId: request.guildId,
          channelId: request.channelId,
          threadId: request.threadId,
        },
        "Failed to ask the owner about Discord channel access",
      );
      await presentation.updatePendingNotice(pending, "owner-unreachable");
      return;
    }

    await this.save(pending);
  }

  /** Returns the decision when the interaction was one of this requester's buttons. */
  async handleButton(button: {
    readonly customId: string;
    readonly userId: string;
  }): Promise<DiscordChannelAccessButtonResult> {
    const parsed = parseDiscordChannelAccessButtonId(button.customId);
    if (!parsed) return { kind: "ignored" };

    if (!this.dependencies.ownerUserId || button.userId !== this.dependencies.ownerUserId) {
      return { kind: "rejected", reason: "owner-only" };
    }

    const pending = this.pendingByRequestId.get(parsed.requestId);
    if (!pending) return { kind: "rejected", reason: "expired" };

    try {
      await this.dependencies.accessRuleStore.setAccess(
        {
          guildId: pending.guildId,
          channelId: pending.channelId,
          ...(pending.threadId ? { threadId: pending.threadId } : {}),
        },
        parsed.action,
      );
    } catch (error) {
      this.dependencies.logger?.error(
        {
          err: error,
          event: "discord_channel_access_update_failed",
          guildId: pending.guildId,
          channelId: pending.channelId,
          threadId: pending.threadId,
        },
        "Failed to update Discord channel access",
      );
      return { kind: "rejected", reason: "rule-update-failed" };
    }

    await this.remove(pending);
    return { kind: "decided", request: pending, access: parsed.action };
  }

  private remember(pending: PendingDiscordAccessRequest): void {
    this.pendingByLocation.set(discordChannelAccessRequestLocationKey(pending), pending);
    this.pendingByRequestId.set(pending.requestId, pending);
  }

  private async save(pending: PendingDiscordAccessRequest): Promise<void> {
    try {
      await this.dependencies.accessRequestStore.save(pending);
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_persist_failed",
          requestId: pending.requestId,
        },
        "Failed to persist a Discord channel access request",
      );
    }
  }

  private async remove(pending: PendingDiscordAccessRequest): Promise<void> {
    this.pendingByLocation.delete(discordChannelAccessRequestLocationKey(pending));
    this.pendingByRequestId.delete(pending.requestId);
    try {
      await this.dependencies.accessRequestStore.remove(pending.requestId);
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_channel_access_request_remove_failed",
          requestId: pending.requestId,
        },
        "Failed to remove a persisted Discord channel access request",
      );
    }
  }
}
