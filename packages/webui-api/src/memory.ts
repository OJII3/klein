export const MEMORY_KINDS = ["fact", "rule", "decision", "procedure", "temporary"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryEntryScope =
  | { readonly type: "owner" }
  | { readonly type: "guild" }
  | { readonly type: "channel"; readonly channelId: string }
  | { readonly type: "thread"; readonly channelId: string; readonly threadId: string };

export interface MemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryEntryScope;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceMessageIds: readonly string[];
}

export interface MemoryDocument {
  readonly entries: readonly MemoryEntry[];
}

export type MemoryScope =
  { readonly type: "owner" } | { readonly type: "guild"; readonly guildId: string };

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface MemoryScopeReader {
  listScopes(): Promise<readonly MemoryScopeSummary[]>;
  read(scope: MemoryScope): Promise<MemoryDocument>;
}

export interface MemoryScopeEditor {
  addRule(scope: MemoryScope, title: string, content: string): Promise<void>;
  deleteEntry(scope: MemoryScope, entryId: string): Promise<void>;
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
