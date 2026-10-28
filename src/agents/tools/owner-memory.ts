import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import {
  MEMORY_KINDS,
  MemoryEntryNotFoundError,
  type MemoryEntry,
  type MemoryKind,
} from "@modules/memory/domain/memory";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";

const memoryKindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)));
const ownerMemoryUpdateParameters = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Optional(memoryKindSchema),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
});

type OwnerMemoryUpdateDetails =
  | {
      readonly id: string;
      readonly kind: MemoryKind;
      readonly title: string;
      readonly updated: true;
    }
  | { readonly id: string; readonly updated: false };

export function createOwnerMemoryTools(store: OwnerMemoryStore, sourceId = "agent") {
  return [
    defineTool({
      name: "owner_memory_list",
      description:
        "List entries in the shared owner memory across the communication agent and domain agents. " +
        "Optionally filter by kind (fact, rule, decision, procedure, temporary).",
      parameters: Type.Object({
        kind: Type.Optional(memoryKindSchema),
      }),
      deferred: true,
      replay: "safe",
      async execute(params) {
        const document = await store.read();
        const kindFilter = params.kind as MemoryKind | undefined;
        const entries = kindFilter
          ? document.entries.filter((entry) => entry.kind === kindFilter)
          : document.entries;
        return {
          output: [
            {
              type: "text",
              text:
                entries.length === 0
                  ? "オーナー用メモリにエントリはありません。"
                  : entries.map(formatOwnerMemoryEntry).join("\n\n"),
            },
          ],
          details: {
            count: entries.length,
            entries: entries.map(({ id, kind, title, content, updatedAt }) => ({
              id,
              kind,
              title,
              content,
              updatedAt,
            })),
          },
        };
      },
    }),
    defineTool({
      name: "owner_memory_add",
      description:
        "Add an entry to the shared owner memory so that the communication agent and domain agents can reference it. " +
        "Use kind='temporary' for short-lived notifications or pending context, 'fact' for owner facts, 'decision' for decisions, 'procedure' for workflows, or 'rule' for persistent rules.",
      parameters: Type.Object({
        kind: memoryKindSchema,
        title: Type.String({ minLength: 1, maxLength: 200 }),
        content: Type.String({ minLength: 1, maxLength: 10_000 }),
      }),
      deferred: true,
      async execute(params) {
        const entry = await store.addEntry({
          kind: params.kind as MemoryKind,
          title: params.title,
          content: params.content,
          sourceId,
        });
        return {
          output: [
            {
              type: "text",
              text: `オーナー用メモリに追加しました。ID: ${entry.id} (${entry.kind}) — ${entry.title}`,
            },
          ],
          details: { id: entry.id, kind: entry.kind, title: entry.title },
        };
      },
    }),
    defineTool<typeof ownerMemoryUpdateParameters, OwnerMemoryUpdateDetails>({
      name: "owner_memory_update",
      description:
        "Update an existing entry in the shared owner memory by its ID (e.g., mem_...). Use owner_memory_list to find IDs if needed.",
      parameters: ownerMemoryUpdateParameters,
      deferred: true,
      async execute(params) {
        try {
          const updated = await store.updateEntry({
            id: params.id,
            ...(params.kind !== undefined ? { kind: params.kind as MemoryKind } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.content !== undefined ? { content: params.content } : {}),
            sourceId,
          });
          return {
            output: [
              {
                type: "text",
                text: `オーナー用メモリを更新しました。ID: ${updated.id} (${updated.kind}) — ${updated.title}`,
              },
            ],
            details: { id: updated.id, kind: updated.kind, title: updated.title, updated: true },
          };
        } catch (error) {
          if (error instanceof MemoryEntryNotFoundError) {
            return {
              output: [
                {
                  type: "text",
                  text: `指定されたID (${params.id}) のオーナー用メモリは見つかりませんでした。`,
                },
              ],
              details: { id: params.id, updated: false },
            };
          }
          throw error;
        }
      },
    }),
    defineTool({
      name: "owner_memory_delete",
      description:
        "Delete an entry from the shared owner memory by its ID (e.g., when a temporary notification or task has been handled).",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
      }),
      deferred: true,
      async execute(params) {
        const deleted = await store.deleteEntry(params.id);
        return {
          output: [
            {
              type: "text",
              text: deleted
                ? `オーナー用メモリ ${params.id} を削除しました。`
                : `指定されたID (${params.id}) のオーナー用メモリは見つかりませんでした。`,
            },
          ],
          details: { id: params.id, deleted },
        };
      },
    }),
  ];
}

function formatOwnerMemoryEntry(entry: MemoryEntry): string {
  return `- ${entry.id} [${entry.kind}] ${entry.title} (updated: ${entry.updatedAt.slice(0, 10)})\n  ${entry.content}`;
}
