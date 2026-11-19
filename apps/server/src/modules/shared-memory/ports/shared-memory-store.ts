import type {
  SharedMemory,
  SharedMemoryFile,
  SharedMemoryScope,
  SharedMemorySummary,
} from "../domain/shared-memory";

export interface SharedMemoryStore {
  read(guildId: string, scope: SharedMemoryScope): Promise<SharedMemory>;
  write(guildId: string, scope: SharedMemoryScope, memory: SharedMemory): Promise<void>;
  writeContent(guildId: string, scope: SharedMemoryScope, content: string): Promise<void>;
  delete(guildId: string, scope: SharedMemoryScope): Promise<void>;
  listFiles(guildId: string): Promise<readonly SharedMemoryFile[]>;
  listGuildIds(): Promise<readonly string[]>;
}

export interface SharedMemoryGuild {
  readonly guildId: string;
  readonly files: readonly SharedMemoryFile[];
}

export interface SharedMemoryReader {
  listGuilds(): Promise<readonly SharedMemorySummary[]>;
  readGuild(guildId: string): Promise<SharedMemoryGuild>;
}

export interface SharedMemoryEditor {
  writeFile(guildId: string, scope: SharedMemoryScope, content: string): Promise<void>;
  deleteFile(guildId: string, scope: SharedMemoryScope): Promise<void>;
}
