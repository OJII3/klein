import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { DiscordChannelLinkTarget } from "../domain/discord-channel-link";
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
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";

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

export type DiscordChannelAccessRequestOutcome =
  | { readonly kind: "requested" }
  | { readonly kind: "pending" }
  | { readonly kind: "already-linked"; readonly userId: string }
  | { readonly kind: "unavailable" };

export interface DiscordChannelAccessServiceDependencies {
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">;
  readonly accessRequestStore: Pick<DiscordAccessRequestStore, "list" | "save" | "remove">;
  readonly channelLinkStore?: Pick<DiscordChannelLinkStore, "getLink" | "saveLink">;
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
  ): Promise<DiscordChannelAccessRequestOutcome> {
    if (!this.dependencies.ownerUserId) return { kind: "unavailable" };

    const key = discordChannelAccessRequestLocationKey(request);
    if (this.pendingByLocation.has(key)) return { kind: "pending" };

    if (request.linkUserId) {
      const existing = this.dependencies.channelLinkStore?.getLink(request);
      if (existing?.userId === request.linkUserId) {
        return { kind: "already-linked", userId: existing.userId };
      }
    }

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
      return { kind: "unavailable" };
    }

    await this.save(pending);
    return { kind: "requested" };
  }

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

    const approved = parsed.action === "allow";
    const target: DiscordChannelLinkTarget = {
      guildId: pending.guildId,
      channelId: pending.channelId,
      ...(pending.threadId ? { threadId: pending.threadId } : {}),
    };

    if (approved && pending.linkUserId && !this.dependencies.channelLinkStore) {
      return { kind: "rejected", reason: "link-update-failed" };
    }

    // Denying a link request leaves the location's existing access rule untouched.
    if (!(pending.linkUserId && !approved)) {
      try {
        await this.dependencies.accessRuleStore.setAccess(target, parsed.action);
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
    }

    if (approved && pending.linkUserId) {
      try {
        await this.dependencies.channelLinkStore?.saveLink({
          ...target,
          userId: pending.linkUserId,
          linkedAt: new Date().toISOString(),
        });
      } catch (error) {
        this.dependencies.logger?.error(
          {
            err: error,
            event: "discord_channel_link_update_failed",
            guildId: pending.guildId,
            channelId: pending.channelId,
            threadId: pending.threadId,
          },
          "Failed to register the Discord channel link",
        );
        return { kind: "rejected", reason: "link-update-failed" };
      }
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
