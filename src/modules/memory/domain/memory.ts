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
