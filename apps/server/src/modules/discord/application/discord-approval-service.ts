import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  discordApprovalLocationKey,
  parseDiscordApprovalButtonId,
  type DiscordApprovalNoticeOutcome,
  type DiscordApprovalRejection,
  type DiscordApprovalRequest,
  type DiscordApprovalRequestDraft,
} from "../domain/discord-approval-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";

export interface DiscordApprovalPresentation<R extends DiscordApprovalRequest> {
  postPendingNotice(request: R): Promise<{ messageId?: string }>;
  sendOwnerRequest(request: R): Promise<void>;
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

    const key = discordApprovalLocationKey(draft);
    if (this.pendingByLocation.has(key)) return "pending";

    let pending = this.dependencies.createRequest(draft, randomUUID());
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
          event: "discord_approval_pending_message_failed",
          guildId: draft.guildId,
          channelId: draft.channelId,
          threadId: draft.threadId,
        },
        "Failed to post the pending Discord approval notice",
      );
    }

    try {
      await presentation.sendOwnerRequest(pending);
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

    await this.save(pending);
    return "requested";
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

  private remember(pending: R): void {
    this.pendingByLocation.set(discordApprovalLocationKey(pending), pending);
    this.pendingByRequestId.set(pending.requestId, pending);
  }

  private async save(pending: R): Promise<void> {
    try {
      await this.dependencies.store.save(pending);
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_request_persist_failed",
          requestId: pending.requestId,
        },
        "Failed to persist a Discord approval request",
      );
    }
  }

  private async remove(pending: R): Promise<void> {
    this.pendingByLocation.delete(discordApprovalLocationKey(pending));
    this.pendingByRequestId.delete(pending.requestId);
    try {
      await this.dependencies.store.remove(pending.requestId);
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          event: "discord_approval_request_remove_failed",
          requestId: pending.requestId,
        },
        "Failed to remove a persisted Discord approval request",
      );
    }
  }
}
