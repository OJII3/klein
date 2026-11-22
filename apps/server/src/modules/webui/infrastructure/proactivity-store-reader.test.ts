import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { InitiativeGoal } from "@modules/initiative/domain/initiative-goal";
import { FileFollowUpStore } from "@modules/proactivity/infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "@modules/proactivity/infrastructure/file-proactive-preference-store";
import { FileProactiveSignalStore } from "@modules/proactivity/infrastructure/file-proactive-signal-store";
import { FileInitiativeGoalStore } from "@modules/initiative/infrastructure/file-initiative-goal-store";
import { ProactivityStoreReader } from "./proactivity-store-reader";
import { createTempDir } from "../../../testing/temp-dir";

const signalBase: ProactiveSignal = {
  version: 1,
  id: "signal-a",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "weather",
  summary: "雨が降りそう",
  urgency: "today",
  dedupeKey: "dedupe-a",
  observedAt: "2026-11-20T00:00:00.000Z",
  status: "queued",
};

const followUpBase: FollowUp = {
  version: 1,
  id: "follow-up-a",
  channelId: "channel-a",
  accessScope: "owner:123",
  subject: "牛乳を確認する",
  watcher: { kind: "watch", id: "watch-1" },
  cadenceLabel: "5分ごと",
  status: "active",
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

const goalBase: InitiativeGoal = {
  version: 1,
  id: "goal-a",
  channelId: "channel-a",
  accessScope: "owner:123",
  title: "店を調べる",
  rationale: "店の話をしていた",
  source: { kind: "conversation", messageIds: ["m1"] },
  plan: "好みに合う店を3軒調べる",
  dueAt: "2026-11-22T12:00:00+09:00",
  expiresAt: "2026-11-23T12:00:00+09:00",
  risk: "low",
  delivery: "attach",
  status: "scheduled",
  dedupeKey: "goal-dedupe",
  createdBy: "planner",
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};

test("maps stored proactivity records into a newest-first Web UI snapshot", async () => {
  await using temp = await createTempDir("klein-proactivity-reader-");

  const signalStore = new FileProactiveSignalStore(join(temp.path, "signals"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const preferenceStore = new FileProactivePreferenceStore(join(temp.path, "preferences"));
  const goalStore = new FileInitiativeGoalStore(join(temp.path, "goals"));

  await Promise.all([
    signalStore.create(signalBase),
    signalStore.create({
      ...signalBase,
      id: "signal-b",
      dedupeKey: "dedupe-b",
      observedAt: "2026-11-20T02:00:00.000Z",
      status: "surfaced",
      evidence: { url: "https://example.com/weather" },
      delivery: { mode: "attach", surfacedAt: "2026-11-20T02:10:00.000Z" },
    }),
    signalStore.create({
      ...signalBase,
      id: "signal-c",
      dedupeKey: "dedupe-c",
      observedAt: "2026-11-20T01:00:00.000Z",
      urgency: "silent",
      delivery: { mode: "silent" },
    }),
    followUpStore.create(followUpBase),
    followUpStore.create({
      ...followUpBase,
      id: "follow-up-b",
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
    }),
    goalStore.create(goalBase),
    preferenceStore.update(
      { channelId: "channel-a", accessScope: "owner:123" },
      { kind: "add_note", text: "短く" },
    ),
    preferenceStore.update(
      { channelId: "channel-b", accessScope: "public" },
      { kind: "set_topic", topic: "weather", mode: "mute" },
    ),
  ]);

  const reader = new ProactivityStoreReader({
    preferenceStore,
    followUpStore,
    signalStore,
    goalStore,
    signalLimit: 2,
  });
  const snapshot = await reader.read();

  assert.deepEqual(
    snapshot.signals.map((signal) => signal.id),
    ["signal-b", "signal-c"],
  );
  assert.equal(snapshot.signalsTruncated, true);
  assert.deepEqual(snapshot.signals[0]?.evidence, { url: "https://example.com/weather" });
  assert.equal(snapshot.signals[0]?.deliveryMode, "attach");
  assert.equal(snapshot.signals[0]?.surfacedAt, "2026-11-20T02:10:00.000Z");
  assert.deepEqual(
    snapshot.followUps.map((followUp) => followUp.id),
    ["follow-up-b", "follow-up-a"],
  );
  assert.deepEqual(
    snapshot.goals.map((goal) => goal.id),
    ["goal-a"],
  );
  assert.equal(snapshot.goals[0]?.deliveryMode, "attach");
  assert.deepEqual(snapshot.preferences, [
    {
      key: "channel-channel-b",
      scope: "channel",
      channelId: "channel-b",
      delivery: {},
      topics: [{ topic: "weather", mode: "mute" }],
      notes: [],
    },
    {
      key: "user-123",
      scope: "user",
      userId: "123",
      delivery: {},
      topics: [],
      notes: ["短く"],
    },
  ]);
});
