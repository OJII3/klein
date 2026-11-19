import type { GuildMemoryScope } from "../domain/guild-memory";
import type {
  GuildMemoryEditor,
  GuildMemoryGuild,
  GuildMemoryReader,
} from "../ports/guild-memory-store";

export interface WebUiMemorySummary {
  readonly scope: { readonly type: "guild"; readonly guildId: string };
  readonly entryCount: number;
  readonly updatedAt: string | null;
}

export interface WebUiMemoryAccessor {
  listScopes(): Promise<readonly WebUiMemorySummary[]>;
  readGuild(guildId: string): Promise<GuildMemoryGuild>;
  writeFile(guildId: string, scope: GuildMemoryScope, content: string): Promise<void>;
  deleteFile(guildId: string, scope: GuildMemoryScope): Promise<void>;
}

export function createWebUiMemoryAccessor(
  guildMemory?: GuildMemoryReader & GuildMemoryEditor,
): WebUiMemoryAccessor {
  return {
    async listScopes(): Promise<readonly WebUiMemorySummary[]> {
      if (!guildMemory) return [];
      return (await guildMemory.listGuilds()).map((summary) => ({
        entryCount: summary.itemCount,
        scope: { guildId: summary.guildId, type: "guild" },
        updatedAt: summary.updatedAt,
      }));
    },
    async readGuild(guildId: string): Promise<GuildMemoryGuild> {
      return guildMemory ? guildMemory.readGuild(guildId) : { files: [], guildId };
    },
    async writeFile(guildId: string, scope: GuildMemoryScope, content: string): Promise<void> {
      if (!guildMemory) throw new Error("Guild memory is disabled");
      await guildMemory.writeFile(guildId, scope, content);
    },
    async deleteFile(guildId: string, scope: GuildMemoryScope): Promise<void> {
      if (!guildMemory) throw new Error("Guild memory is disabled");
      await guildMemory.deleteFile(guildId, scope);
    },
  };
}
