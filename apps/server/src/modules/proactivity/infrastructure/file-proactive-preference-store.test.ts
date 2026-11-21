import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "bun:test";

import { DEFAULT_PROACTIVE_PREFERENCES } from "../domain/proactive-preference";
import { FileProactivePreferenceStore } from "./file-proactive-preference-store";

const ownerTarget = { channelId: "channel-a", accessScope: "owner:123" } as const;
const otherUserTarget = { channelId: "channel-b", accessScope: "user:456" } as const;
const publicTarget = { channelId: "channel-c", accessScope: "public" } as const;

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "klein-proactive-preferences-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns defaults until the first update creates the user template", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(directory);

    assert.deepEqual(await store.read(ownerTarget), DEFAULT_PROACTIVE_PREFERENCES);
    assert.deepEqual(await readdir(directory), []);

    const updated = await store.update(ownerTarget, {
      kind: "set_delivery",
      key: "default",
      value: "attach",
    });
    const markdown = await readFile(join(directory, "user-123.md"), "utf8");

    assert.match(markdown, /^# Proactive preferences\n/u);
    assert.match(markdown, /## Delivery\n- default: attach/u);
    assert.match(markdown, /## Topics\n/u);
    assert.match(markdown, /## Notes\n/u);
    assert.equal(updated.delivery.defaultMode, "attach");
    assert.deepEqual(await store.read(ownerTarget), updated);
  });
});

test("keeps unknown lines and sections while updating known values", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "user-123.md");
    const store = new FileProactivePreferenceStore(directory);
    await writeFile(
      path,
      [
        "# Proactive preferences",
        "",
        "## Delivery",
        "- timezone: Asia/Tokyo",
        "- default: attach",
        "",
        "## Custom",
        "- keep me",
        "",
        "## Notes",
        "- 残す",
        "",
      ].join("\n"),
      "utf8",
    );

    const updated = await store.update(ownerTarget, {
      kind: "set_topic",
      topic: "weather",
      mode: "mute",
      until: "2026-12-01",
    });
    const markdown = await readFile(path, "utf8");

    assert.match(markdown, /- timezone: Asia\/Tokyo/u);
    assert.match(markdown, /## Custom\n- keep me/u);
    assert.match(markdown, /- 残す/u);
    assert.deepEqual(updated.topics, [{ topic: "weather", mode: "mute", until: "2026-12-01" }]);
    assert.deepEqual(await store.read(ownerTarget), updated);
  });
});

test("serializes concurrent updates without losing changes", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(directory);

    await Promise.all([
      store.update(ownerTarget, { kind: "set_delivery", key: "default", value: "attach" }),
      store.update(ownerTarget, { kind: "set_delivery", key: "max_per_day", value: "2" }),
      store.update(ownerTarget, { kind: "set_topic", topic: "weather", mode: "mute" }),
      store.update(ownerTarget, { kind: "add_note", text: "短く" }),
    ]);

    assert.deepEqual(await store.read(ownerTarget), {
      delivery: { defaultMode: "attach", maxPerDay: 2 },
      topics: [{ topic: "weather", mode: "mute" }],
      notes: ["短く"],
    });
  });
});

test("shares user preferences across channels and keeps public channels separate", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(directory);

    await store.update(ownerTarget, { kind: "add_note", text: "所有者の好み" });
    await store.update(otherUserTarget, { kind: "add_note", text: "別ユーザーの好み" });
    await store.update(publicTarget, { kind: "add_note", text: "公開チャンネルの好み" });

    const sameOwnerInAnotherChannel = await store.read({
      channelId: "channel-d",
      accessScope: "owner:123",
    });
    assert.deepEqual(sameOwnerInAnotherChannel.notes, ["所有者の好み"]);
    assert.deepEqual((await store.read(otherUserTarget)).notes, ["別ユーザーの好み"]);
    assert.deepEqual((await store.read(publicTarget)).notes, ["公開チャンネルの好み"]);
    assert.deepEqual((await readdir(directory)).toSorted(), [
      "channel-channel-c.md",
      "user-123.md",
      "user-456.md",
    ]);
  });
});

test("lists every stored preference file by key", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(directory);
    await store.update(ownerTarget, { kind: "add_note", text: "所有者の好み" });
    await store.update(publicTarget, { kind: "set_topic", topic: "weather", mode: "mute" });
    await writeFile(join(directory, "notes.txt"), "ignored", "utf8");

    assert.deepEqual(await store.list(), [
      {
        key: "channel-channel-c",
        preferences: {
          delivery: {},
          topics: [{ mode: "mute", topic: "weather" }],
          notes: [],
        },
      },
      {
        key: "user-123",
        preferences: {
          delivery: {},
          topics: [],
          notes: ["所有者の好み"],
        },
      },
    ]);
  });
});

test("lists no preferences when the directory is missing", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(join(directory, "missing"));

    assert.deepEqual(await store.list(), []);
  });
});
