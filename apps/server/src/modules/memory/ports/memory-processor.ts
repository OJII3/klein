import type { GuildMemoryMessage, GuildMemoryScopeState } from "../domain/guild-memory";

export interface MemoryProcessor {
  process(
    guildId: string,
    scopes: readonly GuildMemoryScopeState[],
    messages: readonly GuildMemoryMessage[],
  ): Promise<void>;
}
