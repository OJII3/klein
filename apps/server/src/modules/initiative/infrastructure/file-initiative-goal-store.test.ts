import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import type { InitiativeGoal } from "../domain/initiative-goal";
import { FileInitiativeGoalStore } from "./file-initiative-goal-store";

test("stores goals as one JSON file per goal and filters by scope", async () => {
  await using temp = await createTempDir("klein-initiative-goals-");
  const store = new FileInitiativeGoalStore(join(temp.path, "goals"));
  const first = makeGoal({ id: "goal-1" });
  const second = makeGoal({ id: "goal-2", channelId: "channel-2" });

  await store.create(first);
  await store.create(second);

  assert.deepEqual(await store.get("goal-1"), first);
  assert.deepEqual(
    (await store.listForScope("channel-1", "owner:1")).map((goal) => goal.id),
    ["goal-1"],
  );
  assert.deepEqual(
    (await store.listAll()).map((goal) => goal.id),
    ["goal-1", "goal-2"],
  );
});

test("updates a goal and finds it by worker id", async () => {
  await using temp = await createTempDir("klein-initiative-goals-");
  const store = new FileInitiativeGoalStore(join(temp.path, "goals"));
  const goal = makeGoal({ id: "goal-1" });
  await store.create(goal);

  const updated = { ...goal, status: "running" as const, workerId: "worker-1" };
  await store.update(updated);

  assert.deepEqual(await store.findByWorkerId("worker-1"), updated);
  assert.equal(await store.findByWorkerId("worker-2"), undefined);
});

test("quarantines a corrupt sibling and keeps reading valid goals", async () => {
  await using temp = await createTempDir("klein-initiative-goals-");
  const directory = join(temp.path, "goals");
  const store = new FileInitiativeGoalStore(directory);
  const goal = makeGoal({ id: "goal-1" });
  await store.create(goal);
  await writeFile(join(directory, "broken.json"), "{not json", "utf8");
  await writeFile(join(directory, "invalid.json"), JSON.stringify({ id: "goal-2" }), "utf8");

  assert.deepEqual(await store.listAll(), [goal]);
  assert.equal(await store.get("broken"), undefined);
  assert.deepEqual(await store.get("goal-1"), goal);
  assert.equal((await readdir(join(directory, "corrupt"))).length, 2);
});

function makeGoal(overrides: Partial<InitiativeGoal> = {}): InitiativeGoal {
  return {
    version: 1,
    id: "goal-1",
    channelId: "channel-1",
    accessScope: "owner:1",
    title: "店を調べる",
    rationale: "昨日の会話で店の話をした",
    source: { kind: "conversation", messageIds: ["m1"] },
    plan: "好みに合う店を3軒調べて返す",
    dueAt: "2026-11-22T12:00:00+09:00",
    expiresAt: "2026-11-23T12:00:00+09:00",
    risk: "low",
    delivery: "attach",
    status: "scheduled",
    dedupeKey: "dedupe",
    createdBy: "planner",
    createdAt: "2026-11-21T12:00:00+09:00",
    updatedAt: "2026-11-21T12:00:00+09:00",
    ...overrides,
  };
}
