export const MEMORY_KINDS = ["fact", "rule", "decision", "procedure", "temporary"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceMessageIds: readonly string[];
}

export interface MemoryDocument {
  readonly entries: readonly MemoryEntry[];
}

export interface MemoryGuildSummary {
  readonly guildId: string;
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface MemoryReader {
  listGuilds(): Promise<readonly MemoryGuildSummary[]>;
  read(guildId: string): Promise<MemoryDocument>;
}

export interface MemoryEditor {
  deleteEntry(guildId: string, entryId: string): Promise<void>;
}

export class MemoryEntryNotFoundError extends Error {
  constructor(guildId: string, entryId: string) {
    super(`Memory entry was not found: ${guildId}/${entryId}`);
    this.name = "MemoryEntryNotFoundError";
  }
}

export type MemoryOperation =
  | {
      readonly type: "add";
      readonly kind: MemoryKind;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly type: "update";
      readonly id: string;
      readonly kind: MemoryKind;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly type: "delete";
      readonly id: string;
    }
  | {
      readonly type: "noop";
    };

export interface MemoryStore {
  read(): Promise<MemoryDocument>;
  apply(operations: readonly MemoryOperation[], sourceMessageIds: readonly string[]): Promise<void>;
}

export interface MemoryMessage {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
}

export interface MemoryProcessor {
  process(
    document: MemoryDocument,
    messages: readonly MemoryMessage[],
  ): Promise<readonly MemoryOperation[]>;
}
