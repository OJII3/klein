import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWebUiMemoryAccessor,
  OWNER_MEMORY_GUILD_ID,
  OwnerMemoryStore,
} from "./application/owner-memory-store";
import { createOwnerMemoryTools } from "@agents/tools/owner-memory";

test("OwnerMemoryStore supports CRUD, context selection, and WebUI accessor", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "klein-owner-memory-"));
  try {
    const store = new OwnerMemoryStore(join(tempDir, "owner-memory", "MEMORY.json"));

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

    // Even with an unrelated greeting, rule and temporary entries are included in context
    const greetingContext = await store.getContext("おはよう！");
    assert.ok(greetingContext);
    assert.match(greetingContext, /# Owner Memory/);
    assert.match(greetingContext, /通知ポリシー/);
    assert.match(greetingContext, /15:00の定例MTGが16:00に変更された/);
    assert.match(greetingContext, new RegExp(`Memory ID: ${tempEntry.id}`));

    // Update entry
    const updated = await store.updateEntry({
      id: tempEntry.id,
      content: "15:00の定例MTGは明日へ延期された",
    });
    assert.equal(updated.content, "15:00の定例MTGは明日へ延期された");

    // WebUI accessor lists "owner" and reads/edits it
    const accessor = createWebUiMemoryAccessor(store);
    const guilds = await accessor.listGuilds();
    assert.equal(guilds.length, 1);
    assert.equal(guilds[0]?.guildId, OWNER_MEMORY_GUILD_ID);
    assert.equal(guilds[0]?.entryCount, 2);

    await accessor.deleteEntry(OWNER_MEMORY_GUILD_ID, tempEntry.id);
    const afterDelete = await accessor.read(OWNER_MEMORY_GUILD_ID);
    assert.deepEqual(
      afterDelete.entries.map((entry) => entry.id),
      [ruleEntry.id],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createOwnerMemoryTools executes list, add, update, and delete", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "klein-owner-memory-tools-"));
  try {
    const store = new OwnerMemoryStore(join(tempDir, "MEMORY.json"));
    const tools = createOwnerMemoryTools(store, "agent:mail");
    const findTool = (name: string) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `Expected tool ${name}`);
      return tool;
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
