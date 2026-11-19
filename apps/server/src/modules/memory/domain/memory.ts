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

export interface MemoryLocation {
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
}

export type MemoryScope =
  { readonly type: "owner" } | { readonly type: "guild"; readonly guildId: string };

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly entryCount: number;
  readonly updatedAt: string | null;
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
      readonly scope: MemoryEntryScope;
      readonly kind: MemoryKind;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly type: "update";
      readonly scope: MemoryEntryScope;
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
