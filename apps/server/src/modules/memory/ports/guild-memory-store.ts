import type {
  GuildMemory,
  GuildMemoryFile,
  GuildMemoryScope,
  GuildMemorySummary,
} from "../domain/guild-memory";

export interface GuildMemoryStore {
  read(guildId: string, scope: GuildMemoryScope): Promise<GuildMemory>;
  write(guildId: string, scope: GuildMemoryScope, memory: GuildMemory): Promise<void>;
  writeContent(guildId: string, scope: GuildMemoryScope, content: string): Promise<void>;
  delete(guildId: string, scope: GuildMemoryScope): Promise<void>;
  listFiles(guildId: string): Promise<readonly GuildMemoryFile[]>;
  listGuildIds(): Promise<readonly string[]>;
}

export interface GuildMemoryGuild {
  readonly guildId: string;
  readonly files: readonly GuildMemoryFile[];
}

export interface GuildMemoryReader {
  listGuilds(): Promise<readonly GuildMemorySummary[]>;
  readGuild(guildId: string): Promise<GuildMemoryGuild>;
}

export interface GuildMemoryEditor {
  writeFile(guildId: string, scope: GuildMemoryScope, content: string): Promise<void>;
  deleteFile(guildId: string, scope: GuildMemoryScope): Promise<void>;
}
