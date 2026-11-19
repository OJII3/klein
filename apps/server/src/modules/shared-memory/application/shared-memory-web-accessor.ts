import type { SharedMemoryScope } from "../domain/shared-memory";
import type {
  SharedMemoryEditor,
  SharedMemoryGuild,
  SharedMemoryReader,
} from "../ports/shared-memory-store";

export interface WebUiSharedMemorySummary {
  readonly scope: { readonly type: "guild"; readonly guildId: string };
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface WebUiSharedMemoryAccessor {
  listScopes(): Promise<readonly WebUiSharedMemorySummary[]>;
  readGuild(guildId: string): Promise<SharedMemoryGuild>;
  writeFile(guildId: string, scope: SharedMemoryScope, content: string): Promise<void>;
  deleteFile(guildId: string, scope: SharedMemoryScope): Promise<void>;
}

export function createWebUiSharedMemoryAccessor(
  sharedMemory?: SharedMemoryReader & SharedMemoryEditor,
): WebUiSharedMemoryAccessor {
  return {
    async listScopes(): Promise<readonly WebUiSharedMemorySummary[]> {
      if (!sharedMemory) return [];
      return (await sharedMemory.listGuilds()).map((summary) => ({
        entryCount: summary.itemCount,
        scope: { guildId: summary.guildId, type: "guild" },
        updatedAt: summary.updatedAt,
      }));
    },
    async readGuild(guildId: string): Promise<SharedMemoryGuild> {
      return sharedMemory ? sharedMemory.readGuild(guildId) : { files: [], guildId };
    },
    async writeFile(guildId: string, scope: SharedMemoryScope, content: string): Promise<void> {
      if (!sharedMemory) throw new Error("Shared memory is disabled");
      await sharedMemory.writeFile(guildId, scope, content);
    },
    async deleteFile(guildId: string, scope: SharedMemoryScope): Promise<void> {
      if (!sharedMemory) throw new Error("Shared memory is disabled");
      await sharedMemory.deleteFile(guildId, scope);
    },
  };
}
