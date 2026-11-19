import type {
  GuildMemoryMessage,
  GuildMemoryScopeState,
  GuildMemoryUpdate,
} from "../domain/guild-memory";

export interface MemoryProcessor {
  process(
    scopes: readonly GuildMemoryScopeState[],
    messages: readonly GuildMemoryMessage[],
  ): Promise<readonly GuildMemoryUpdate[]>;
}
