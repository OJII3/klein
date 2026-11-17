import type { PendingDiscordAccessRequest } from "../domain/discord-access-request";

export type { PendingDiscordAccessRequest } from "../domain/discord-access-request";

/** Persists owner approval requests so their buttons keep working after a restart. */
export interface DiscordAccessRequestStore {
  load(): Promise<void>;
  list(): readonly PendingDiscordAccessRequest[];
  save(request: PendingDiscordAccessRequest): Promise<void>;
  remove(requestId: string): Promise<void>;
}
