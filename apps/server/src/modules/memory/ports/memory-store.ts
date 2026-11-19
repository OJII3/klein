import type { MemoryApplyResult, MemoryDocument, MemoryOperation } from "../domain/memory";

export interface MemoryStore {
  read(): Promise<MemoryDocument>;
  apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<MemoryApplyResult>;
}

export interface OwnerMemoryReader {
  read(): Promise<MemoryDocument>;
}

export interface OwnerMemoryEditor {
  addRule(title: string, content: string): Promise<void>;
  deleteEntry(entryId: string): Promise<void>;
}
