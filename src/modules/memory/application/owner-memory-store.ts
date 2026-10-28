import {
  MemoryEntryNotFoundError,
  type GuildMemoryEditor,
  type GuildMemoryReader,
  type MemoryApplyResult,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryKind,
  type MemoryOperation,
  type MemoryScope,
  type MemoryScopeEditor,
  type MemoryScopeReader,
  type MemoryScopeSummary,
  type MemoryStore,
} from "../domain/memory";
import { renderOwnerMemoryContext } from "../infrastructure/memory-context-renderer";
import { selectMemoryEntries } from "./memory-context-selector";

const DEFAULT_RECENT_FALLBACK_LIMIT = 5;
const MAX_OWNER_MEMORY_RULE_ENTRIES = 5;
const MAX_OWNER_MEMORY_TEMPORARY_ENTRIES = 3;
export const MAX_OWNER_MEMORY_CONTEXT_ENTRIES = 12;
export const MAX_OWNER_MEMORY_CONTEXT_CHARACTERS = 8_000;

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
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: MemoryStore) {}

  async read(): Promise<MemoryDocument> {
    return this.store.read();
  }

  async apply(
    operations: readonly MemoryOperation[],
    sourceIds: readonly string[] = [],
  ): Promise<MemoryApplyResult> {
    return this.runOperation(() => this.store.apply(operations, sourceIds));
  }

  async addEntry(input: OwnerMemoryAddInput): Promise<MemoryEntry> {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title) throw new Error("Owner memory title must not be empty");
    if (!content) throw new Error("Owner memory content must not be empty");

    return this.runOperation(async () => {
      const result = await this.store.apply(
        [{ type: "add", kind: input.kind, title, content }],
        input.sourceId ? [input.sourceId] : [],
      );
      const created = result.created[0];
      if (!created) throw new Error("Failed to create owner memory entry");
      return created;
    });
  }

  async updateEntry(input: OwnerMemoryUpdateInput): Promise<MemoryEntry> {
    return this.runOperation(async () => {
      const document = await this.store.read();
      const existing = document.entries.find((entry) => entry.id === input.id);
      if (!existing) {
        throw new MemoryEntryNotFoundError({ type: "owner" }, input.id);
      }

      const kind = input.kind ?? existing.kind;
      const title = input.title !== undefined ? input.title.trim() : existing.title;
      const content = input.content !== undefined ? input.content.trim() : existing.content;
      if (!title) throw new Error("Owner memory title must not be empty");
      if (!content) throw new Error("Owner memory content must not be empty");

      const result = await this.store.apply(
        [{ type: "update", id: input.id, kind, title, content }],
        input.sourceId ? [input.sourceId] : [],
      );
      const updated = result.updated[0];
      if (!updated) throw new Error(`Failed to update owner memory entry: ${input.id}`);
      return updated;
    });
  }

  async deleteEntry(id: string): Promise<boolean> {
    return this.runOperation(async () => {
      const document = await this.store.read();
      if (!document.entries.some((entry) => entry.id === id)) return false;
      const result = await this.store.apply([{ type: "delete", id }], []);
      return result.deleted.length > 0;
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
  const rules = mostRecentlyUpdated(
    document.entries.filter((entry) => entry.kind === "rule"),
  ).slice(0, MAX_OWNER_MEMORY_RULE_ENTRIES);
  const temporary = mostRecentlyUpdated(
    document.entries.filter((entry) => entry.kind === "temporary"),
  ).slice(0, MAX_OWNER_MEMORY_TEMPORARY_ENTRIES);
  const pinned = [...rules, ...temporary];
  const pinnedIds = new Set(pinned.map((entry) => entry.id));
  const pinnedKindIds = new Set(
    document.entries
      .filter((entry) => entry.kind === "rule" || entry.kind === "temporary")
      .map((entry) => entry.id),
  );

  const matched = selectMemoryEntries(document, query, {
    maxRelatedEntries: MAX_OWNER_MEMORY_CONTEXT_ENTRIES,
  }).entries.filter((entry) => !pinnedKindIds.has(entry.id));
  const selectedIds = new Set([...pinnedIds, ...matched.map((entry) => entry.id)]);

  const recentFallback =
    matched.length >= recentFallbackLimit
      ? []
      : [...document.entries]
          .filter((entry) => !pinnedKindIds.has(entry.id) && !selectedIds.has(entry.id))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, Math.max(0, recentFallbackLimit - matched.length));

  const candidates = [...pinned, ...matched, ...recentFallback];
  const entries: MemoryEntry[] = [];
  for (const entry of candidates) {
    if (entries.length >= MAX_OWNER_MEMORY_CONTEXT_ENTRIES) break;
    const nextEntries = [...entries, entry];
    if (
      renderOwnerMemoryContext({ entries: nextEntries }, { includeIds: true }).length <=
      MAX_OWNER_MEMORY_CONTEXT_CHARACTERS
    ) {
      entries.push(entry);
    }
  }

  return { entries };
}

export function createWebUiMemoryAccessor(
  ownerMemory?: OwnerMemoryStore,
  guildMemory?: GuildMemoryReader & GuildMemoryEditor,
): MemoryScopeReader & MemoryScopeEditor {
  return {
    async listScopes(): Promise<readonly MemoryScopeSummary[]> {
      const ownerSummaries = ownerMemory
        ? [createOwnerMemorySummary(await ownerMemory.read())]
        : [];
      const guildSummaries = guildMemory
        ? (await guildMemory.listGuilds()).map((summary): MemoryScopeSummary => ({
            entryCount: summary.entryCount,
            scope: { guildId: summary.guildId, type: "guild" },
            updatedAt: summary.updatedAt,
          }))
        : [];
      return [...ownerSummaries, ...guildSummaries];
    },
    async read(scope: MemoryScope): Promise<MemoryDocument> {
      if (scope.type === "owner") {
        return ownerMemory ? ownerMemory.read() : { entries: [] };
      }
      if (!guildMemory) return { entries: [] };
      return guildMemory.read(scope.guildId);
    },
    async addRule(scope: MemoryScope, title: string, content: string): Promise<void> {
      if (scope.type === "owner") {
        if (!ownerMemory) throw new Error("Owner memory is disabled");
        await ownerMemory.addEntry({ kind: "rule", title, content, sourceId: "webui" });
        return;
      }
      if (!guildMemory) throw new Error("Guild memory is disabled");
      await guildMemory.addRule(scope.guildId, title, content);
    },
    async deleteEntry(scope: MemoryScope, entryId: string): Promise<void> {
      if (scope.type === "owner") {
        if (!ownerMemory || !(await ownerMemory.deleteEntry(entryId))) {
          throw new MemoryEntryNotFoundError(scope, entryId);
        }
        return;
      }
      if (!guildMemory) throw new MemoryEntryNotFoundError(scope, entryId);
      await guildMemory.deleteEntry(scope.guildId, entryId);
    },
  };
}

function createOwnerMemorySummary(document: MemoryDocument): MemoryScopeSummary {
  return {
    entryCount: document.entries.length,
    scope: { type: "owner" },
    updatedAt: document.entries.reduce<string | null>(
      (latest, entry) => (latest === null || entry.updatedAt > latest ? entry.updatedAt : latest),
      null,
    ),
  };
}

function mostRecentlyUpdated(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
