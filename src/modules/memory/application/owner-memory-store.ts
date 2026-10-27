import {
  MemoryEntryNotFoundError,
  type MemoryDocument,
  type MemoryEditor,
  type MemoryEntry,
  type MemoryGuildSummary,
  type MemoryKind,
  type MemoryOperation,
  type MemoryReader,
} from "../domain/memory";
import { JsonMemoryStore } from "../infrastructure/json-memory-store";
import { renderOwnerMemoryContext } from "../infrastructure/memory-context-renderer";
import { selectMemoryEntries } from "./memory-context-selector";

export const OWNER_MEMORY_GUILD_ID = "owner";
const DEFAULT_RECENT_FALLBACK_LIMIT = 5;

export interface OwnerMemoryAddInput {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly sourceId?: string;
}

export interface OwnerMemoryUpdateInput {
  readonly id: string;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly sourceId?: string;
}

export class OwnerMemoryStore {
  private readonly store: JsonMemoryStore;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.store = new JsonMemoryStore(filePath);
  }

  async read(): Promise<MemoryDocument> {
    return this.store.read();
  }

  async apply(
    operations: readonly MemoryOperation[],
    sourceIds: readonly string[] = [],
  ): Promise<void> {
    return this.runOperation(() => this.store.apply(operations, sourceIds));
  }

  async addEntry(input: OwnerMemoryAddInput): Promise<MemoryEntry> {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw new Error("Owner memory title must not be empty");
    if (!content) throw new Error("Owner memory content must not be empty");

    return this.runOperation(async () => {
      const before = await this.store.read();
      const beforeIds = new Set(before.entries.map((entry) => entry.id));
      await this.store.apply(
        [{ type: "add", kind: input.kind, title, content }],
        input.sourceId ? [input.sourceId] : [],
      );
      const after = await this.store.read();
      const created =
        after.entries.find((entry) => !beforeIds.has(entry.id)) ?? after.entries.at(-1);
      if (!created) throw new Error("Failed to create owner memory entry");
      return created;
    });
  }

  async updateEntry(input: OwnerMemoryUpdateInput): Promise<MemoryEntry> {
    return this.runOperation(async () => {
      const document = await this.store.read();
      const existing = document.entries.find((entry) => entry.id === input.id);
      if (!existing) {
        throw new MemoryEntryNotFoundError(OWNER_MEMORY_GUILD_ID, input.id);
      }

      const kind = input.kind ?? existing.kind;
      const title = input.title !== undefined ? input.title.trim() : existing.title;
      const content = input.content !== undefined ? input.content.trim() : existing.content;
      if (!title) throw new Error("Owner memory title must not be empty");
      if (!content) throw new Error("Owner memory content must not be empty");

      await this.store.apply(
        [{ type: "update", id: input.id, kind, title, content }],
        input.sourceId ? [input.sourceId] : [],
      );
      const after = await this.store.read();
      const updated = after.entries.find((entry) => entry.id === input.id);
      if (!updated) throw new Error(`Failed to update owner memory entry: ${input.id}`);
      return updated;
    });
  }

  async deleteEntry(id: string): Promise<boolean> {
    return this.runOperation(async () => {
      const document = await this.store.read();
      if (!document.entries.some((entry) => entry.id === id)) {
        return false;
      }
      await this.store.apply([{ type: "delete", id }], []);
      return true;
    });
  }

  async getContext(query: string): Promise<string | undefined> {
    const document = await this.read();
    if (document.entries.length === 0) return undefined;

    const selected = selectOwnerMemoryEntries(document, query);
    if (selected.entries.length === 0) return undefined;

    return renderOwnerMemoryContext(selected, { includeIds: true });
  }

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

export function selectOwnerMemoryEntries(
  document: MemoryDocument,
  query: string,
  recentFallbackLimit = DEFAULT_RECENT_FALLBACK_LIMIT,
): MemoryDocument {
  const pinned = document.entries.filter(
    (entry) => entry.kind === "rule" || entry.kind === "temporary",
  );
  const pinnedIds = new Set(pinned.map((entry) => entry.id));

  const matched = selectMemoryEntries(document, query).entries.filter(
    (entry) => !pinnedIds.has(entry.id),
  );
  const selectedIds = new Set([...pinnedIds, ...matched.map((entry) => entry.id)]);

  const recentFallback =
    matched.length >= recentFallbackLimit
      ? []
      : [...document.entries]
          .filter((entry) => !selectedIds.has(entry.id))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, recentFallbackLimit - matched.length);

  return {
    entries: [...pinned, ...matched, ...recentFallback],
  };
}

export function createWebUiMemoryAccessor(
  ownerMemory: OwnerMemoryStore,
  guildMemory?: MemoryReader & MemoryEditor,
): MemoryReader & MemoryEditor {
  return {
    async listGuilds(): Promise<readonly MemoryGuildSummary[]> {
      const ownerDoc = await ownerMemory.read();
      const ownerSummary: MemoryGuildSummary = {
        guildId: OWNER_MEMORY_GUILD_ID,
        entryCount: ownerDoc.entries.length,
        updatedAt: ownerDoc.entries.reduce<string | null>(
          (latest, entry) =>
            latest === null || entry.updatedAt > latest ? entry.updatedAt : latest,
          null,
        ),
      };
      const guildSummaries = guildMemory ? await guildMemory.listGuilds() : [];
      return [
        ownerSummary,
        ...guildSummaries.filter((item) => item.guildId !== OWNER_MEMORY_GUILD_ID),
      ];
    },
    async read(guildId: string): Promise<MemoryDocument> {
      if (guildId === OWNER_MEMORY_GUILD_ID) {
        return ownerMemory.read();
      }
      if (!guildMemory) return { entries: [] };
      return guildMemory.read(guildId);
    },
    async addRule(guildId: string, title: string, content: string): Promise<void> {
      if (guildId === OWNER_MEMORY_GUILD_ID) {
        await ownerMemory.addEntry({ kind: "rule", title, content, sourceId: "webui" });
        return;
      }
      if (!guildMemory) throw new Error("Guild memory is disabled");
      await guildMemory.addRule(guildId, title, content);
    },
    async deleteEntry(guildId: string, entryId: string): Promise<void> {
      if (guildId === OWNER_MEMORY_GUILD_ID) {
        const deleted = await ownerMemory.deleteEntry(entryId);
        if (!deleted) throw new MemoryEntryNotFoundError(OWNER_MEMORY_GUILD_ID, entryId);
        return;
      }
      if (!guildMemory) throw new MemoryEntryNotFoundError(guildId, entryId);
      await guildMemory.deleteEntry(guildId, entryId);
    },
  };
}
