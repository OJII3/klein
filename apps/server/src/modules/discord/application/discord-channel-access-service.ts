import type { Logger } from "pino";

import {
  DiscordApprovalService,
  type DiscordApprovalButtonResult,
  type DiscordApprovalPresentation,
  type DiscordApprovalRequestOutcome,
} from "./discord-approval-service";
import {
  DISCORD_CHANNEL_ACCESS_BUTTON_PREFIX,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";

export type DiscordChannelAccessButtonResult =
  DiscordApprovalButtonResult<PendingDiscordAccessRequest>;

export type DiscordChannelAccessRequestOutcome = DiscordApprovalRequestOutcome;

export interface DiscordChannelAccessServiceDependencies {
  readonly accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">;
  readonly accessRequestStore: Pick<
    DiscordApprovalRequestStore<PendingDiscordAccessRequest>,
    "list" | "save" | "remove"
  >;
  readonly ownerUserId?: string;
  readonly logger?: Logger;
}

export class DiscordChannelAccessService {
  private readonly approval: DiscordApprovalService<PendingDiscordAccessRequest>;

  constructor(dependencies: DiscordChannelAccessServiceDependencies) {
    this.approval = new DiscordApprovalService({
      store: dependencies.accessRequestStore,
      buttonPrefix: DISCORD_CHANNEL_ACCESS_BUTTON_PREFIX,
      createRequest: (draft, requestId) => ({ ...draft, requestId }),
      ownerUserId: dependencies.ownerUserId,
      logger: dependencies.logger,
      hooks: {
        onAllow: async (request) => {
          await dependencies.accessRuleStore.setAccess(
            {
              guildId: request.guildId,
              channelId: request.channelId,
              ...(request.threadId ? { threadId: request.threadId } : {}),
            },
            "allow",
          );
          return undefined;
        },
        onDeny: async (request) => {
          await dependencies.accessRuleStore.setAccess(
            {
              guildId: request.guildId,
              channelId: request.channelId,
              ...(request.threadId ? { threadId: request.threadId } : {}),
            },
            "deny",
          );
          return undefined;
        },
      },
    });
  }

  request(
    request: DiscordChannelAccessRequest,
    presentation: DiscordApprovalPresentation<PendingDiscordAccessRequest>,
  ): Promise<DiscordChannelAccessRequestOutcome> {
    return this.approval.request(request, presentation);
  }

  handleButton(button: {
    readonly customId: string;
    readonly userId: string;
  }): Promise<DiscordChannelAccessButtonResult> {
    return this.approval.handleButton(button);
  }

  cancelPending(
    location: { readonly guildId: string; readonly channelId: string; readonly threadId?: string },
    presentation: Pick<
      DiscordApprovalPresentation<PendingDiscordAccessRequest>,
      "updatePendingNotice"
    >,
  ): Promise<void> {
    return this.approval.cancelPending(location, presentation);
  }
}
