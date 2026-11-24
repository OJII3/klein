import type { Logger } from "pino";

import type {
  DiscordApprovalNoticeOutcome,
  DiscordApprovalRejection,
} from "../domain/discord-approval-request";
import {
  DISCORD_CHANNEL_ACCESS_BUTTON_PREFIX,
  type DiscordChannelAccessRequest,
  type PendingDiscordAccessRequest,
} from "../domain/discord-access-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";
import type { DiscordAccessRuleStore } from "../ports/discord-access-rule-store";
import {
  DiscordChannelAccessService,
  type DiscordChannelAccessRequestOutcome,
} from "../application/discord-channel-access-service";
import {
  DiscordApprovalRequester,
  type DiscordApprovalButtonInteraction,
  type DiscordApprovalClient,
  type DiscordApprovalMessages,
} from "./discord-approval-requester";

export type { DiscordChannelAccessRequest } from "../domain/discord-access-request";
export type DiscordChannelAccessButtonInteraction = DiscordApprovalButtonInteraction;
export type DiscordChannelAccessClient = DiscordApprovalClient;
export type {
  DiscordChannelAccessNoticeOutcome,
  DiscordChannelAccessRejection,
} from "../domain/discord-access-request";

const REJECTION_MESSAGES: Readonly<Record<DiscordApprovalRejection, string>> = {
  "owner-only": "この操作を実行できるのはオーナーだけです。",
  expired: "このリクエストは既に処理済みか、期限切れです。",
  "update-failed": "アクセスルールを更新できませんでした。",
  conflict: "このリクエストは他の操作と競合しました。",
};

const ACCESS_MESSAGES: DiscordApprovalMessages<PendingDiscordAccessRequest> = {
  pendingNotice: (request) => ({
    text: [
      "### 承認待ち",
      `<@${request.requesterUserId}> からのメンションを受け取りましたが、このチャンネルは許可されていません。`,
      "オーナーに確認しています。",
    ].join("\n"),
    tone: "warning",
  }),
  ownerRequest: (_request, location) => ({
    text: [
      "### チャンネルの許可リクエスト",
      ...location,
      "",
      "このチャンネルを許可しますか？",
    ].join("\n"),
    tone: "warning",
  }),
  decision: (_request, allowed, location) => ({
    text: [
      allowed ? "### 許可しました" : "### 拒否しました",
      ...location,
      "",
      allowed ? "このチャンネルを許可しました。" : "このチャンネルは許可しませんでした。",
    ].join("\n"),
    tone: allowed ? "success" : "danger",
  }),
  notice: (_request, outcome) => noticeFor(outcome),
  rejection: (reason) => REJECTION_MESSAGES[reason],
};

function noticeFor(outcome: DiscordApprovalNoticeOutcome): {
  text: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  const notices = {
    allowed: {
      text: "### 許可されました\nこのチャンネルが許可されました。もう一度メンションしてください。",
      tone: "success" as const,
    },
    denied: {
      text: "### 拒否されました\nこのチャンネルは許可されませんでした。",
      tone: "danger" as const,
    },
    expired: {
      text: "### 期限切れです\nこの承認リクエストは期限切れになりました。もう一度 Klein にメンションしてください。",
      tone: "warning" as const,
    },
    "owner-unreachable": {
      text: "### 確認できませんでした\nオーナーに確認できなかったため、このチャンネルでは返信できません。",
      tone: "danger" as const,
    },
  };
  return notices[outcome];
}

export class DiscordChannelAccessRequester {
  private readonly approval: DiscordApprovalRequester<PendingDiscordAccessRequest>;

  constructor(
    client: DiscordApprovalClient,
    accessRuleStore: Pick<DiscordAccessRuleStore, "setAccess">,
    accessRequestStore: Pick<
      DiscordApprovalRequestStore<PendingDiscordAccessRequest>,
      "list" | "save" | "remove"
    >,
    ownerUserId: string | undefined,
    logger?: Logger,
  ) {
    const service = new DiscordChannelAccessService({
      accessRuleStore,
      accessRequestStore,
      ownerUserId,
      logger,
    });
    this.approval = new DiscordApprovalRequester({
      client,
      service,
      messages: ACCESS_MESSAGES,
      buttonPrefix: DISCORD_CHANNEL_ACCESS_BUTTON_PREFIX,
      ownerUserId,
      logger,
    });
  }

  request(request: DiscordChannelAccessRequest): Promise<DiscordChannelAccessRequestOutcome> {
    return this.approval.request(request);
  }

  handleButton(interaction: DiscordApprovalButtonInteraction): Promise<boolean> {
    return this.approval.handleButton(interaction);
  }

  reconcile(): Promise<void> {
    return this.approval.reconcile();
  }
}
