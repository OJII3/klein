import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import { createOwnerMemoryTools } from "@agents/tools/owner-memory";
import type {
  MemoryApplyResult,
  MemoryDocument,
  MemoryEntry,
  MemoryOperation,
  MemoryStore,
} from "./domain/memory";
import {
  createWebUiMemoryAccessor,
  MAX_OWNER_MEMORY_CONTEXT_CHARACTERS,
  MAX_OWNER_MEMORY_CONTEXT_ENTRIES,
  OwnerMemoryStore,
  selectOwnerMemoryEntries,
} from "./application/owner-memory-store";

test("OwnerMemoryStore supports CRUD, context selection, and WebUI access", async () => {
  const backingStore = new FakeMemoryStore();
  const store = new OwnerMemoryStore(backingStore);

  assert.equal(await store.getContext("おはよう"), undefined);

  const ruleEntry = await store.addEntry({
    kind: "rule",
    title: "通知ポリシー",
    content: "重要度の高い予定変更はコミュニケーションエージェントへ伝える",
    sourceId: "agent:calendar",
  });
  const tempEntry = await store.addEntry({
    kind: "temporary",
    title: "本日の予定変更",
    content: "15:00の定例MTGが16:00に変更された",
    sourceId: "agent:calendar",
  });

  const greetingContext = await store.getContext("おはよう！");
  assert.ok(greetingContext);
  assert.match(greetingContext, /# Owner Memory/);
  assert.match(greetingContext, /通知ポリシー/);
  assert.match(greetingContext, /15:00の定例MTGが16:00に変更された/);
  assert.match(greetingContext, new RegExp(`Memory ID: ${tempEntry.id}`));

  const updated = await store.updateEntry({
    id: tempEntry.id,
    content: "15:00の定例MTGは明日へ延期された",
  });
  assert.equal(updated.content, "15:00の定例MTGは明日へ延期された");

  const accessor = createWebUiMemoryAccessor(store);
  const scopes = await accessor.listScopes();
  assert.deepEqual(scopes, [
    {
      entryCount: 2,
      scope: { type: "owner" },
      updatedAt: updated.updatedAt,
    },
  ]);

  await accessor.deleteEntry({ type: "owner" }, tempEntry.id);
  const afterDelete = await accessor.read({ type: "owner" });
  assert.deepEqual(
    afterDelete.entries.map((entry) => entry.id),
    [ruleEntry.id],
  );
});

test("owner memory selection bounds pinned entries, total entries, and rendered size", async () => {
  const document: MemoryDocument = {
    entries: [
      ...Array.from({ length: 12 }, (_, index) =>
        createEntry(`rule-${index}`, "rule", `Rule ${index}`, "A rule."),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        createEntry(`temporary-${index}`, "temporary", `Temporary ${index}`, "Temporary."),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        createEntry(`fact-${index}`, "fact", `Fact ${index}`, "ordinary memory."),
      ),
    ],
  };

  const selected = selectOwnerMemoryEntries(document, "");
  const rendered = await new OwnerMemoryStore(new FakeMemoryStore(document)).getContext("");

  assert.ok(selected.entries.length <= MAX_OWNER_MEMORY_CONTEXT_ENTRIES);
  assert.ok(selected.entries.filter((entry) => entry.kind === "rule").length <= 5);
  assert.ok(selected.entries.filter((entry) => entry.kind === "temporary").length <= 3);
  assert.ok(rendered);
  assert.ok(rendered.length <= MAX_OWNER_MEMORY_CONTEXT_CHARACTERS);
});

test("createOwnerMemoryTools executes list, add, update, and delete", async () => {
  const store = new OwnerMemoryStore(new FakeMemoryStore());
  const tools = createOwnerMemoryTools(store, "agent:mail");
  const findTool = (name: string): ToolRegistration => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `Expected tool ${name}`);
    return tool as unknown as ToolRegistration;
  };

  const addResult = await findTool("owner_memory_add").execute(
    {
      kind: "temporary",
      title: "A社からの返信待ち",
      content: "見積書の確認メールが到着している",
    },
    { callId: "call-1" } as never,
    {} as never,
  );
  const createdId = (addResult.details as { id: string }).id;
  assert.ok(createdId.startsWith("mem_"));

  const listResult = await findTool("owner_memory_list").execute(
    { kind: "temporary" },
    { callId: "call-2" } as never,
    {} as never,
  );
  assert.equal((listResult.details as { count: number }).count, 1);

  const updateResult = await findTool("owner_memory_update").execute(
    { id: createdId, content: "見積書の確認メールに返信済み", kind: "fact" },
    { callId: "call-3" } as never,
    {} as never,
  );
  assert.equal((updateResult.details as { updated: boolean }).updated, true);

  const deleteResult = await findTool("owner_memory_delete").execute(
    { id: createdId },
    { callId: "call-4" } as never,
    {} as never,
  );
  assert.equal((deleteResult.details as { deleted: boolean }).deleted, true);
});

class FakeMemoryStore implements MemoryStore {
  private entries: MemoryEntry[];
  private nextId = 1;

  constructor(document: MemoryDocument = { entries: [] }) {
    this.entries = [...document.entries];
  }

  async read(): Promise<MemoryDocument> {
    return {
      entries: this.entries.map((entry) => ({
        ...entry,
        sourceMessageIds: [...entry.sourceMessageIds],
      })),
    };
  }

  async apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<MemoryApplyResult> {
    const result: { created: MemoryEntry[]; updated: MemoryEntry[]; deleted: MemoryEntry[] } = {
      created: [],
      updated: [],
      deleted: [],
    };
    const sourceIds = [...new Set(sourceMessageIds)];

    for (const operation of operations) {
      if (operation.type === "noop") continue;
      if (operation.type === "add") {
        const now = new Date(Date.UTC(2026, 0, 1, 0, 0, this.nextId++)).toISOString();
        const entry: MemoryEntry = {
          content: operation.content,
          createdAt: now,
          id: `mem_${this.nextId}`,
          kind: operation.kind,
          sourceMessageIds: sourceIds,
          title: operation.title,
          updatedAt: now,
        };
        this.entries.push(entry);
        result.created.push(entry);
        continue;
      }

      const index = this.entries.findIndex((entry) => entry.id === operation.id);
      if (index === -1) throw new Error(`Memory entry was not found: ${operation.id}`);
      const previous = this.entries[index];
      assert.ok(previous);
      if (operation.type === "delete") {
        this.entries.splice(index, 1);
        result.deleted.push(previous);
      } else {
        const now = new Date(Date.UTC(2026, 0, 1, 0, 0, this.nextId++)).toISOString();
        const updated: MemoryEntry = {
          ...previous,
          content: operation.content,
          kind: operation.kind,
          sourceMessageIds: [...new Set([...previous.sourceMessageIds, ...sourceIds])],
          title: operation.title,
          updatedAt: now,
        };
        this.entries[index] = updated;
        result.updated.push(updated);
      }
    }

    return result;
  }
}

function createEntry(
  id: string,
  kind: MemoryEntry["kind"],
  title: string,
  content: string,
): MemoryEntry {
  return {
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    kind,
    sourceMessageIds: [],
    title,
    updatedAt: `2026-01-${String(Number(id.split("-").at(-1)) + 1).padStart(2, "0")}T00:00:00.000Z`,
  };
}
