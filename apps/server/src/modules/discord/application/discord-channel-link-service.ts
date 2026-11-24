import type { Logger } from "pino";

import {
  DiscordApprovalService,
  type DiscordApprovalPresentation,
  type DiscordApprovalRequestOutcome,
} from "./discord-approval-service";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import {
  DISCORD_CHANNEL_LINK_BUTTON_PREFIX,
  type DiscordChannelLinkRequest,
  type PendingDiscordChannelLinkRequest,
} from "../domain/discord-channel-link-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";

export type DiscordChannelUnlinkResult =
  | { readonly kind: "unlinked"; readonly link: DiscordChannelLink }
  | { readonly kind: "not-linked" }
  | { readonly kind: "failed" };

export interface DiscordChannelLinkServiceDependencies {
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">;
  readonly linkStore: Pick<DiscordChannelLinkStore, "getLink" | "saveLink" | "removeLink">;
  readonly requestStore: Pick<
    DiscordApprovalRequestStore<PendingDiscordChannelLinkRequest>,
    "list" | "save" | "remove"
  >;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export class DiscordChannelLinkService {
  private readonly approval: DiscordApprovalService<PendingDiscordChannelLinkRequest>;

  constructor(private readonly dependencies: DiscordChannelLinkServiceDependencies) {
    this.approval = new DiscordApprovalService({
      store: dependencies.requestStore,
      buttonPrefix: DISCORD_CHANNEL_LINK_BUTTON_PREFIX,
      createRequest: (draft, requestId) => ({ ...draft, requestId }),
      ownerUserId: dependencies.ownerUserId,
      logger: dependencies.logger,
      now: dependencies.now,
      hooks: {
        onAllow: async (request) => {
          const current = dependencies.linkStore.getLink(request);
          if (current && current.userId !== request.requesterUserId) return "conflict";

          await dependencies.accessRuleStore.setAccess(targetFor(request), "allow");
          try {
            await dependencies.linkStore.saveLink({
              ...targetFor(request),
              userId: request.requesterUserId,
              linkedAt: new Date().toISOString(),
            });
          } catch (error) {
            dependencies.logger?.error(
              {
                err: error,
                event: "discord_channel_link_save_failed",
                guildId: request.guildId,
                channelId: request.channelId,
                threadId: request.threadId,
              },
              "Failed to save a Discord channel link",
            );
            return "update-failed";
          }
          return undefined;
        },
        onDeny: async () => undefined,
      },
    });
  }

  request(
    request: DiscordChannelLinkRequest,
    presentation: DiscordApprovalPresentation<PendingDiscordChannelLinkRequest>,
  ): Promise<DiscordApprovalRequestOutcome> {
    return this.approval.request(request, presentation);
  }

  handleButton(button: { readonly customId: string; readonly userId: string }) {
    return this.approval.handleButton(button);
  }

  cancelPending(
    location: { readonly guildId: string; readonly channelId: string; readonly threadId?: string },
    presentation: Pick<
      DiscordApprovalPresentation<PendingDiscordChannelLinkRequest>,
      "updatePendingNotice"
    >,
  ): Promise<void> {
    return this.approval.cancelPending(location, presentation);
  }

  async unlink(
    target: DiscordChannelLinkTarget,
    presentation: Pick<
      DiscordApprovalPresentation<PendingDiscordChannelLinkRequest>,
      "updatePendingNotice"
    >,
  ): Promise<DiscordChannelUnlinkResult> {
    const link = this.dependencies.linkStore.getLink(target);
    if (!link) {
      await this.approval.cancelPending(target, presentation);
      return { kind: "not-linked" };
    }

    try {
      await this.dependencies.accessRuleStore.setAccess(target, "deny");
    } catch (error) {
      this.dependencies.logger?.error(
        {
          err: error,
          event: "discord_channel_unlink_access_update_failed",
          guildId: target.guildId,
          channelId: target.channelId,
          threadId: target.threadId,
        },
        "Failed to deny access while unlinking a Discord channel",
      );
      return { kind: "failed" };
    }

    try {
      await this.dependencies.linkStore.removeLink(target);
    } catch (error) {
      this.dependencies.logger?.error(
        {
          err: error,
          event: "discord_channel_unlink_failed",
          guildId: target.guildId,
          channelId: target.channelId,
          threadId: target.threadId,
        },
        "Failed to remove a Discord channel link",
      );
      return { kind: "failed" };
    }

    await this.approval.cancelPending(target, presentation);
    return { kind: "unlinked", link };
  }
}

function targetFor(request: PendingDiscordChannelLinkRequest): DiscordChannelLinkTarget {
  return {
    guildId: request.guildId,
    channelId: request.channelId,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  };
}
