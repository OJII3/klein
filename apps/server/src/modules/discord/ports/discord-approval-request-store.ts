import type { DiscordApprovalRequest } from "../domain/discord-approval-request";

/** Persists owner approval requests so their buttons keep working after a restart. */
export interface DiscordApprovalRequestStore<R extends DiscordApprovalRequest> {
  load(): Promise<void>;
  list(): readonly R[];
  save(request: R): Promise<void>;
  remove(requestId: string): Promise<void>;
}
