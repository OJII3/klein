import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoalDedupeKey,
  isActiveGoal,
  isGoalDue,
  isGoalExpired,
  markGoalDelivered,
  markGoalFailed,
  markGoalReady,
  markGoalRunning,
  parseInitiativeGoal,
  type InitiativeGoal,
} from "./initiative-goal";

const NOW = Date.parse("2026-11-21T12:00:00+09:00");

test("parses a valid goal", () => {
  const goal = makeGoal();
  assert.deepEqual(parseInitiativeGoal(goal), goal);
});

test("rejects a goal with an invalid status", () => {
  assert.throws(
    () => parseInitiativeGoal({ ...makeGoal(), status: "pending" }),
    /Goal の保存内容が不正です/u,
  );
});

test("rejects a goal whose expiry is before its due time", () => {
  assert.throws(
    () =>
      parseInitiativeGoal({
        ...makeGoal(),
        expiresAt: "2026-11-22T11:00:00+09:00",
      }),
    /Goal の保存内容が不正です/u,
  );
});

test("transitions a goal through running, ready, and delivered", () => {
  const goal = makeGoal();
  const running = markGoalRunning(goal, NOW);
  assert.equal(running.status, "running");

  const ready = markGoalReady(running, "signal-1", NOW);
  assert.equal(ready.status, "ready");
  assert.equal(ready.signalId, "signal-1");

  const delivered = markGoalDelivered(ready, NOW);
  assert.equal(delivered.status, "delivered");
});

test("marks a failed goal with the error", () => {
  const failed = markGoalFailed(makeGoal(), "boom", NOW);
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "boom");
});

test("detects due and expired goals", () => {
  const goal = makeGoal();
  assert.equal(isGoalDue(goal, Date.parse(goal.dueAt) - 1), false);
  assert.equal(isGoalDue(goal, Date.parse(goal.dueAt)), true);
  assert.equal(isGoalExpired(goal, Date.parse(goal.expiresAt) - 1), false);
  assert.equal(isGoalExpired(goal, Date.parse(goal.expiresAt)), true);
});

test("counts scheduled, running, and ready goals as active", () => {
  assert.equal(isActiveGoal(makeGoal()), true);
  assert.equal(isActiveGoal(makeGoal({ status: "running" })), true);
  assert.equal(isActiveGoal(makeGoal({ status: "ready" })), true);
  assert.equal(isActiveGoal(makeGoal({ status: "delivered" })), false);
});

test("builds a stable dedupe key for the same title, messages, and day", () => {
  const first = createGoalDedupeKey({
    title: "  店を調べる ",
    sourceMessageIds: ["m2", "m1"],
    dueAt: "2026-11-22T12:00:00+09:00",
  });
  const second = createGoalDedupeKey({
    title: "店を調べる",
    sourceMessageIds: ["m1", "m2"],
    dueAt: "2026-11-22T18:00:00+09:00",
  });
  assert.equal(first, second);
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
