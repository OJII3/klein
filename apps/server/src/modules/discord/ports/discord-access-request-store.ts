export interface PendingDiscordAccessRequest {
  readonly requestId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly pendingChannelId: string;
  readonly channelName?: string;
  readonly requesterUserId: string;
  readonly pendingMessageId?: string;
}

/** Persists owner approval requests so their buttons keep working after a restart. */
export interface DiscordAccessRequestStore {
  load(): Promise<void>;
  list(): readonly PendingDiscordAccessRequest[];
  save(request: PendingDiscordAccessRequest): Promise<void>;
  remove(requestId: string): Promise<void>;
}
