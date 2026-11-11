export const USER_MEMORY_SECTION_KEYS = ["facts", "history", "inCommon", "strengthening"] as const;

export type UserMemorySectionKey = (typeof USER_MEMORY_SECTION_KEYS)[number];

export const USER_MEMORY_SECTION_HEADINGS: Readonly<Record<UserMemorySectionKey, string>> = {
  facts: "Facts",
  history: "History",
  inCommon: "In common",
  strengthening: "Strengthening",
};

export const USER_MEMORY_DEFAULT_SECTION_CONTENT: Readonly<Record<UserMemorySectionKey, string>> = {
  facts: "不明",
  history: "なし",
  inCommon: "なし",
  strengthening: "なし",
};

export const USER_MEMORY_IMPRESSION_MIN = -100;
export const USER_MEMORY_IMPRESSION_MAX = 100;

export interface UserMemory {
  /** User-set Discord username (the part after @), not the numeric snowflake ID. */
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

export interface UserMemoryPatch {
  readonly displayName?: string;
  readonly nickname?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly summary?: string;
  readonly impression?: number;
  readonly impressionDelta?: number;
  readonly facts?: string;
  readonly history?: string;
  readonly inCommon?: string;
  readonly strengthening?: string;
}

export interface UserMemoryIdentity {
  readonly username: string;
  readonly displayName: string;
}

export interface UserMemorySummary {
  /** Numeric Discord user ID, which is also the file key. */
  readonly userId: string;
  /** User-set Discord username, not the numeric snowflake ID. */
  readonly discordId: string;
  readonly displayName: string;
  readonly summary: string;
  readonly impression: number;
  readonly updatedAt: string;
}

export interface UserMemoryStore {
  read(userId: string): Promise<UserMemory | undefined>;
  ensure(userId: string, identity: UserMemoryIdentity): Promise<UserMemory>;
  update(userId: string, identity: UserMemoryIdentity, patch: UserMemoryPatch): Promise<UserMemory>;
}

export interface UserMemoryReader {
  list(): Promise<readonly UserMemorySummary[]>;
  read(userId: string): Promise<UserMemory | undefined>;
}

export interface UserMemoryMessage {
  readonly id: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly occurredAt: string;
  readonly content: string;
}

export interface UserMemoryProcessor {
  process(
    userId: string,
    memory: UserMemory,
    messages: readonly UserMemoryMessage[],
  ): Promise<UserMemory | undefined>;
}

export function clampImpression(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(
    USER_MEMORY_IMPRESSION_MIN,
    Math.min(USER_MEMORY_IMPRESSION_MAX, Math.round(value)),
  );
}
