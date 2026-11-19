import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "bun:test";

import { DEFAULT_PROACTIVE_PREFERENCES } from "../domain/proactive-preference";
import { FileProactivePreferenceStore } from "./file-proactive-preference-store";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "klein-proactive-preferences-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns defaults until the first update creates the template", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "proactive", "preferences.md");
    const store = new FileProactivePreferenceStore(path);

    assert.deepEqual(await store.read(), DEFAULT_PROACTIVE_PREFERENCES);
    await assert.rejects(readFile(path, "utf8"), /ENOENT/u);

    const updated = await store.update({
      kind: "set_delivery",
      key: "default",
      value: "attach",
    });
    const markdown = await readFile(path, "utf8");

    assert.match(markdown, /^# Proactive preferences\n/u);
    assert.match(markdown, /## Delivery\n- default: attach/u);
    assert.match(markdown, /## Topics\n/u);
    assert.match(markdown, /## Notes\n/u);
    assert.equal(updated.delivery.defaultMode, "attach");
    assert.deepEqual(await store.read(), updated);
  });
});

test("keeps unknown lines and sections while updating known values", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "preferences.md");
    const store = new FileProactivePreferenceStore(path);
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

    const updated = await store.update({
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
    assert.deepEqual(await store.read(), updated);
  });
});

test("serializes concurrent updates without losing changes", async () => {
  await withTempDir(async (directory) => {
    const store = new FileProactivePreferenceStore(join(directory, "preferences.md"));

    await Promise.all([
      store.update({ kind: "set_delivery", key: "default", value: "attach" }),
      store.update({ kind: "set_delivery", key: "max_per_day", value: "2" }),
      store.update({ kind: "set_topic", topic: "weather", mode: "mute" }),
      store.update({ kind: "add_note", text: "短く" }),
    ]);

    assert.deepEqual(await store.read(), {
      delivery: { defaultMode: "attach", maxPerDay: 2 },
      topics: [{ topic: "weather", mode: "mute" }],
      notes: ["短く"],
    });
  });
});
