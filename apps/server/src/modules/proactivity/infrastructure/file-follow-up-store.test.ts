import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "bun:test";

import type { FollowUp } from "../domain/follow-up";
import { FileFollowUpStore } from "./file-follow-up-store";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "klein-follow-ups-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const first: FollowUp = {
  version: 1,
  id: "follow-up-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  subject: "牛乳の買い置きを確認する",
  watcher: { kind: "watch", id: "watch-1" },
  cadenceLabel: "5分ごと",
  status: "active",
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

const second: FollowUp = {
  ...first,
  id: "follow-up-2",
  channelId: "channel-b",
  accessScope: "public",
  subject: "リリースを確認する",
  watcher: { kind: "worker", id: "worker-1" },
  cadenceLabel: "ワーカーの完了時",
  createdAt: "2026-11-20T01:00:00.000Z",
  updatedAt: "2026-11-20T01:00:00.000Z",
  originMessageId: "message-1",
};

test("stores, finds, lists, updates, and deletes follow-ups", async () => {
  await withTempDir(async (directory) => {
    const store = new FileFollowUpStore(directory);

    await store.create(second);
    await store.create(first);

    assert.deepEqual(await store.get(first.id), first);
    assert.deepEqual(await store.get("missing"), undefined);
    assert.deepEqual(await store.listForScope("channel-a", "owner:123"), [first]);
    assert.deepEqual(await store.listForScope("channel-a", "public"), []);
    assert.deepEqual(await store.listForScope("channel-b", "public"), [second]);
    assert.deepEqual(await store.listAll(), [first, second]);
    assert.deepEqual(await store.listByWatcher("watch", "watch-1"), [first]);
    assert.deepEqual(await store.listByWatcher("worker", "worker-1"), [second]);
    assert.deepEqual(await store.listByWatcher("watch", "worker-1"), []);

    const updated = { ...first, status: "done" as const, updatedAt: "2026-11-20T02:00:00.000Z" };
    await store.update(updated);
    assert.deepEqual(await store.get(first.id), updated);
    assert.deepEqual(await store.listForScope("channel-a", "owner:123"), [updated]);

    assert.equal(await store.delete(first.id), true);
    assert.equal(await store.delete(first.id), false);
    assert.deepEqual(await store.get(first.id), undefined);
    assert.deepEqual(await store.listForScope("channel-a", "owner:123"), []);
  });
});

test("sorts scoped follow-ups by creation time", async () => {
  await withTempDir(async (directory) => {
    const store = new FileFollowUpStore(directory);
    const earlier = { ...first, id: "earlier", createdAt: "2026-11-19T00:00:00.000Z" };
    const later = { ...first, id: "later", createdAt: "2026-11-21T00:00:00.000Z" };

    await store.create(later);
    await store.create(earlier);

    assert.deepEqual(
      (await store.listForScope("channel-a", "owner:123")).map((followUp) => followUp.id),
      ["earlier", "later"],
    );
  });
});

test("encodes IDs in file names and persists readable JSON", async () => {
  await withTempDir(async (directory) => {
    const store = new FileFollowUpStore(directory);
    const encoded: FollowUp = { ...first, id: "follow/up 1" };

    await store.create(encoded);

    assert.deepEqual(await readdir(directory), ["follow%2Fup%201.json"]);
    const stored: unknown = JSON.parse(
      await readFile(join(directory, "follow%2Fup%201.json"), "utf8"),
    );
    assert.deepEqual(stored, encoded);
    assert.deepEqual(await store.get(encoded.id), encoded);
    assert.equal(await store.delete(encoded.id), true);
  });
});

test("keeps working after a new store instance reads the directory", async () => {
  await withTempDir(async (directory) => {
    await new FileFollowUpStore(directory).create(first);

    const reopened = new FileFollowUpStore(directory);
    assert.deepEqual(await reopened.get(first.id), first);
    assert.deepEqual(await reopened.listForScope("channel-a", "owner:123"), [first]);
  });
});

test("raises for corrupt JSON instead of silently dropping a promise", async () => {
  await withTempDir(async (directory) => {
    const store = new FileFollowUpStore(directory);
    await writeFile(join(directory, "broken.json"), "{", "utf8");
    await writeFile(join(directory, "notes.txt"), "ignored", "utf8");

    await assert.rejects(store.get("broken"));
    await assert.rejects(store.listForScope("channel-a", "owner:123"));
    await assert.rejects(store.listByWatcher("watch", "watch-1"));
  });
});

test("treats a missing directory as empty", async () => {
  await withTempDir(async (directory) => {
    const store = new FileFollowUpStore(join(directory, "missing"));

    assert.deepEqual(await store.get("anything"), undefined);
    assert.deepEqual(await store.listForScope("channel-a", "public"), []);
    assert.deepEqual(await store.listByWatcher("reminder", "reminder-1"), []);
    assert.equal(await store.delete("anything"), false);
  });
});
