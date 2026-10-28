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

export type MemoryScope =
  | { readonly type: "owner" }
  | { readonly type: "guild"; readonly guildId: string };

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface MemoryGuildSummary {
  readonly guildId: string;
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface GuildMemoryReader {
  listGuilds(): Promise<readonly MemoryGuildSummary[]>;
  read(guildId: string): Promise<MemoryDocument>;
}

export interface GuildMemoryEditor {
  addRule(guildId: string, title: string, content: string): Promise<void>;
  deleteEntry(guildId: string, entryId: string): Promise<void>;
}

export interface MemoryScopeReader {
  listScopes(): Promise<readonly MemoryScopeSummary[]>;
  read(scope: MemoryScope): Promise<MemoryDocument>;
}

export interface MemoryScopeEditor {
  addRule(scope: MemoryScope, title: string, content: string): Promise<void>;
  deleteEntry(scope: MemoryScope, entryId: string): Promise<void>;
}

export class MemoryEntryNotFoundError extends Error {
  constructor(scope: MemoryScope, entryId: string) {
    const scopeLabel = scope.type === "owner" ? "owner" : scope.guildId;
    super(`Memory entry was not found: ${scopeLabel}/${entryId}`);
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

export interface MemoryApplyResult {
  readonly created: readonly MemoryEntry[];
  readonly updated: readonly MemoryEntry[];
  readonly deleted: readonly MemoryEntry[];
}

export interface MemoryStore {
  read(): Promise<MemoryDocument>;
  apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<MemoryApplyResult>;
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
