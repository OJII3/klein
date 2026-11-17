import type { MemoryDocument, MemoryMessage, MemoryOperation } from "../domain/memory";

export interface MemoryProcessor {
  process(
    document: MemoryDocument,
    messages: readonly MemoryMessage[],
  ): Promise<readonly MemoryOperation[]>;
}
