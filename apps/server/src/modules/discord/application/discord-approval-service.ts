import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  DISCORD_APPROVAL_REQUEST_TTL_MS,
  discordApprovalLocationKey,
  isDiscordApprovalExpired,
  parseDiscordApprovalButtonId,
  type DiscordApprovalNoticeOutcome,
  type DiscordApprovalRejection,
  type DiscordApprovalRequest,
  type DiscordApprovalRequestDraft,
} from "../domain/discord-approval-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";

export interface DiscordApprovalPresentation<R extends DiscordApprovalRequest> {
  postPendingNotice(request: R): Promise<{ messageId?: string }>;
  sendOwnerRequest(request: R): Promise<{ messageId?: string }>;
  updatePendingNotice(request: R, outcome: DiscordApprovalNoticeOutcome): Promise<void>;
}

export type DiscordApprovalFailure = "update-failed" | "conflict";

export interface DiscordApprovalDecisionHooks<R extends DiscordApprovalRequest> {
  onAllow(request: R): Promise<DiscordApprovalFailure | undefined>;
  onDeny(request: R): Promise<DiscordApprovalFailure | undefined>;
}

export type DiscordApprovalRequestOutcome = "requested" | "pending" | "unavailable";

export type DiscordApprovalButtonResult<R extends DiscordApprovalRequest> =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: DiscordApprovalRejection }
  | { readonly kind: "decided"; readonly request: R; readonly allowed: boolean };

export interface DiscordApprovalServiceDependencies<R extends DiscordApprovalRequest> {
  readonly store: Pick<DiscordApprovalRequestStore<R>, "list" | "save" | "remove">;
  readonly buttonPrefix: string;
  readonly createRequest: (draft: DiscordApprovalRequestDraft<R>, requestId: string) => R;
  readonly hooks: DiscordApprovalDecisionHooks<R>;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/**
 * Tracks owner approval requests and lets only the owner decide them. The
 * request kind supplies persistence and decision hooks; message presentation
 * stays behind {@link DiscordApprovalPresentation}.
 */
export class DiscordApprovalService<R extends DiscordApprovalRequest> {
  private readonly pendingByLocation = new Map<string, R>();
  private readonly pendingByRequestId = new Map<string, R>();

  constructor(private readonly dependencies: DiscordApprovalServiceDependencies<R>) {
    for (const request of dependencies.store.list()) {
      this.remember(request);
    }
  }

  async request(
    draft: DiscordApprovalRequestDraft<R>,
    presentation: DiscordApprovalPresentation<R>,
  ): Promise<DiscordApprovalRequestOutcome> {
    if (!this.dependencies.ownerUserId) return "unavailable";

    const now = this.currentTime();
    const key = discordApprovalLocationKey(draft);
    const current = this.pendingByLocation.get(key);
    if (current && !isDiscordApprovalExpired(current, now)) return "pending";
    if (current) await this.remove(current);

    let pending = this.dependencies.createRequest(draft, randomUUID());
    pending = {
      ...pending,
      expiresAt: new Date(now + DISCORD_APPROVAL_REQUEST_TTL_MS).toISOString(),
    };
    this.remember(pending);

    if (!(await this.save(pending))) {
      await this.remove(pending);
      return "unavailable";
    }

    try {
      const { messageId } = await presentation.postPendingNotice(pending);
      if (messageId) {
        pending = { ...pending, pendingMessageId: messageId };
        this.remember(pending);
        await this.save(pending);
      }
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_pending_message_failed",
          guildId: draft.guildId,
          channelId: draft.channelId,
          threadId: draft.threadId,
        },
        "Failed to post the pending Discord approval notice",
      );
    }

    try {
      const sent = await presentation.sendOwnerRequest(pending);
      if (sent.messageId) {
        pending = { ...pending, ownerMessageId: sent.messageId };
        this.remember(pending);
        await this.save(pending);
      }
    } catch (error) {
      await this.remove(pending);
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_request_failed",
          guildId: draft.guildId,
          channelId: draft.channelId,
          threadId: draft.threadId,
        },
        "Failed to ask the owner about a Discord approval request",
      );
      await presentation.updatePendingNotice(pending, "owner-unreachable");
      return "unavailable";
    }

    return "requested";
  }

  /**
   * Brings persisted requests back in line with Discord at startup. Requests
   * older than their expiry leave the store and their notice says so, and a
   * request whose owner message never went out asks the owner again.
   */
  async reconcile(presentation: DiscordApprovalPresentation<R>): Promise<void> {
    const pendings = Array.from(this.pendingByRequestId.values());
    for (const pending of pendings) {
      if (isDiscordApprovalExpired(pending, this.currentTime())) {
        await this.remove(pending);
        this.dependencies.logger?.info(
          {
            event: "discord_approval_request_expired",
            requestId: pending.requestId,
            guildId: pending.guildId,
            channelId: pending.channelId,
            threadId: pending.threadId,
          },
          "Removed an expired Discord approval request",
        );
        await presentation.updatePendingNotice(pending, "expired");
        continue;
      }

      if (pending.ownerMessageId) continue;

      let ownerMessageId: string | undefined;
      try {
        ownerMessageId = (await presentation.sendOwnerRequest(pending)).messageId;
      } catch (error) {
        await this.remove(pending);
        this.dependencies.logger?.warn(
          {
            err: error,
            event: "discord_approval_owner_resend_failed",
            requestId: pending.requestId,
            guildId: pending.guildId,
            channelId: pending.channelId,
            threadId: pending.threadId,
          },
          "Failed to resend the owner request for a pending Discord approval",
        );
        await presentation.updatePendingNotice(pending, "owner-unreachable");
        continue;
      }

      if (!ownerMessageId) continue;

      const updated = { ...pending, ownerMessageId };
      this.remember(updated);
      await this.save(updated);
      this.dependencies.logger?.info(
        {
          event: "discord_approval_owner_resent",
          requestId: pending.requestId,
          guildId: pending.guildId,
          channelId: pending.channelId,
          threadId: pending.threadId,
        },
        "Resent the owner request for a pending Discord approval",
      );
    }
  }

  async handleButton(button: {
    readonly customId: string;
    readonly userId: string;
  }): Promise<DiscordApprovalButtonResult<R>> {
    const parsed = parseDiscordApprovalButtonId(this.dependencies.buttonPrefix, button.customId);
    if (!parsed) return { kind: "ignored" };

    if (!this.dependencies.ownerUserId || button.userId !== this.dependencies.ownerUserId) {
      return { kind: "rejected", reason: "owner-only" };
    }

    const pending = this.pendingByRequestId.get(parsed.requestId);
    if (!pending) return { kind: "rejected", reason: "expired" };

    if (isDiscordApprovalExpired(pending, this.currentTime())) {
      await this.remove(pending);
      return { kind: "rejected", reason: "expired" };
    }

    const allowed = parsed.action === "allow";
    let failure: DiscordApprovalFailure | undefined;
    try {
      failure = allowed
        ? await this.dependencies.hooks.onAllow(pending)
        : await this.dependencies.hooks.onDeny(pending);
    } catch (error) {
      this.dependencies.logger?.error(
        {
          err: error,
          event: "discord_approval_decision_failed",
          requestId: pending.requestId,
          guildId: pending.guildId,
          channelId: pending.channelId,
          threadId: pending.threadId,
        },
        "Failed to apply a Discord approval decision",
      );
      return { kind: "rejected", reason: "update-failed" };
    }

    if (failure) return { kind: "rejected", reason: failure };

    await this.remove(pending);
    return { kind: "decided", request: pending, allowed };
  }

  async cancelPending(
    location: { readonly guildId: string; readonly channelId: string; readonly threadId?: string },
    presentation: Pick<DiscordApprovalPresentation<R>, "updatePendingNotice">,
    outcome: DiscordApprovalNoticeOutcome = "denied",
  ): Promise<void> {
    const pending = this.pendingByLocation.get(discordApprovalLocationKey(location));
    if (!pending) return;
    await this.remove(pending);
    await presentation.updatePendingNotice(pending, outcome);
  }

  private currentTime(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private remember(pending: R): void {
    this.pendingByLocation.set(discordApprovalLocationKey(pending), pending);
    this.pendingByRequestId.set(pending.requestId, pending);
  }

  private async save(pending: R): Promise<boolean> {
    try {
      await this.dependencies.store.save(pending);
      return true;
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_request_persist_failed",
          requestId: pending.requestId,
        },
        "Failed to persist a Discord approval request",
      );
      return false;
    }
  }

  private async remove(pending: R): Promise<boolean> {
    this.pendingByLocation.delete(discordApprovalLocationKey(pending));
    this.pendingByRequestId.delete(pending.requestId);
    try {
      await this.dependencies.store.remove(pending.requestId);
      return true;
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_request_remove_failed",
          requestId: pending.requestId,
        },
        "Failed to remove a persisted Discord approval request",
      );
      return false;
    }
  }
}
