import type {
  MemoryApplyResult,
  MemoryDocument,
  MemoryGuildSummary,
  MemoryOperation,
  MemoryScope,
  MemoryScopeSummary,
} from "../domain/memory";

export interface MemoryStore {
  read(): Promise<MemoryDocument>;
  apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<MemoryApplyResult>;
}

export interface GuildMemoryStore {
  forGuild(guildId: string): MemoryStore;
  listGuildIds(): Promise<readonly string[]>;
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
