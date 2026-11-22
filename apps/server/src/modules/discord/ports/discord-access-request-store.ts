import type { PendingDiscordAccessRequest } from "../domain/discord-access-request";
import type { DiscordApprovalRequestStore } from "./discord-approval-request-store";

export type { PendingDiscordAccessRequest } from "../domain/discord-access-request";

export type DiscordAccessRequestStore = DiscordApprovalRequestStore<PendingDiscordAccessRequest>;
