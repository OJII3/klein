export type SharedMemoryScope =
  | { readonly type: "guild" }
  | { readonly type: "channel"; readonly channelId: string }
  | { readonly type: "thread"; readonly channelId: string; readonly threadId: string };

export interface SharedMemory {
  readonly facts: readonly string[];
  readonly preferences: readonly string[];
}

export interface SharedMemoryFile extends SharedMemory {
  readonly scope: SharedMemoryScope;
  readonly content: string;
  readonly updatedAt: string;
}

export interface SharedMemoryGuild {
  readonly guildId: string;
  readonly files: readonly SharedMemoryFile[];
}

export type MemoryScope = { readonly type: "guild"; readonly guildId: string };

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface MemoryScopeReader {
  listScopes(): Promise<readonly MemoryScopeSummary[]>;
  readGuild(guildId: string): Promise<SharedMemoryGuild>;
}

export interface SharedMemoryEditor {
  writeFile(guildId: string, scope: SharedMemoryScope, content: string): Promise<void>;
  deleteFile(guildId: string, scope: SharedMemoryScope): Promise<void>;
}

export const USER_MEMORY_SECTION_KEYS = ["facts", "history", "inCommon", "strengthening"] as const;

export type UserMemorySectionKey = (typeof USER_MEMORY_SECTION_KEYS)[number];

export interface UserMemory {
  readonly discordId: string;
  readonly displayName: string;
  readonly nickname?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly summary: string;
  readonly impression: number;
  readonly updatedAt: string;
  readonly facts: string;
  readonly history: string;
  readonly inCommon: string;
  readonly strengthening: string;
}

export interface UserMemorySummary {
  readonly userId: string;
  readonly discordId: string;
  readonly displayName: string;
  readonly summary: string;
  readonly impression: number;
  readonly updatedAt: string;
}

export interface UserMemoryReader {
  list(): Promise<readonly UserMemorySummary[]>;
  read(userId: string): Promise<UserMemory | undefined>;
}

export interface UserMemoryEditor {
  delete(userId: string): Promise<boolean>;
}
