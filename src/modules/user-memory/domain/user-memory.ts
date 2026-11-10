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

export interface UserMemoryStore {
  read(userId: string): Promise<UserMemory | undefined>;
  update(userId: string, username: string, patch: UserMemoryPatch): Promise<UserMemory>;
}

export function clampImpression(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(
    USER_MEMORY_IMPRESSION_MIN,
    Math.min(USER_MEMORY_IMPRESSION_MAX, Math.round(value)),
  );
}
