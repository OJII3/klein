import type { SharedMemoryMessage, SharedMemoryScopeState } from "../domain/shared-memory";

export interface SharedMemoryProcessor {
  process(
    guildId: string,
    scopes: readonly SharedMemoryScopeState[],
    messages: readonly SharedMemoryMessage[],
  ): Promise<void>;
}
