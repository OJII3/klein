import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROACTIVE_PREFERENCES } from "@modules/proactivity/domain/proactive-preference";

import {
  createGoalDedupeKey,
  type InitiativeGoal,
  type InitiativeGoalProposal,
} from "./initiative-goal";
import { decideGoalProposal, type InitiativeGoalPolicyOptions } from "./initiative-goal-policy";

const NOW = Date.parse("2026-11-21T12:00:00+09:00");
const OPTIONS: InitiativeGoalPolicyOptions = {
  maxActiveGoals: 3,
  maxGoalsPerDay: 4,
  approval: "auto",
};

test("accepts a low-risk proposal", () => {
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: [],
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    OPTIONS,
  );
  assert.equal(decision.action, "accept");
  if (decision.action !== "accept") return;
  assert.equal(decision.dueAt, "2026-11-22T03:00:00.000Z");
});

test("rejects a medium-risk proposal", () => {
  const decision = decideGoalProposal(
    {
      proposal: { ...makeProposal(), risk: "medium" },
      existingGoals: [],
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    OPTIONS,
  );
  assert.deepEqual(decision, { action: "reject", reason: "risk medium is not allowed" });
});

test("rejects a duplicate goal", () => {
  const proposal = makeProposal();
  const dueAt = new Date(proposal.dueAt).toISOString();
  const existing = makeGoal({
    dedupeKey: createGoalDedupeKey({
      title: proposal.title,
      dueAt,
      ...(proposal.sourceMessageIds ? { sourceMessageIds: proposal.sourceMessageIds } : {}),
    }),
    dueAt,
  });
  const decision = decideGoalProposal(
    {
      proposal,
      existingGoals: [existing],
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    OPTIONS,
  );
  assert.equal(decision.action, "reject");
});

test("rejects a proposal when the active limit is reached", () => {
  const goals = Array.from({ length: 3 }, (_, index) =>
    makeGoal({ id: `goal-${index}`, dedupeKey: `key-${index}` }),
  );
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: goals,
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    OPTIONS,
  );
  assert.deepEqual(decision, { action: "reject", reason: "too many active goals" });
});

test("rejects a proposal when the daily limit is reached", () => {
  const goals = Array.from({ length: 4 }, (_, index) =>
    makeGoal({
      id: `goal-${index}`,
      dedupeKey: `key-${index}`,
      status: "delivered",
    }),
  );
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: goals,
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    { ...OPTIONS, maxActiveGoals: 10 },
  );
  assert.deepEqual(decision, { action: "reject", reason: "daily goal limit reached" });
});

test("rejects a proposal for a muted topic", () => {
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: [],
      preferences: {
        ...DEFAULT_PROACTIVE_PREFERENCES,
        topics: [{ topic: "店", mode: "mute" }],
      },
      now: NOW,
    },
    OPTIONS,
  );
  assert.deepEqual(decision, { action: "reject", reason: "topic is muted" });
});

test("rejects all proposals when approval is off", () => {
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: [],
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    { ...OPTIONS, approval: "off" },
  );
  assert.deepEqual(decision, { action: "reject", reason: "goal creation is off" });
});

test("defaults the expiry to 24 hours after the due time", () => {
  const decision = decideGoalProposal(
    {
      proposal: makeProposal(),
      existingGoals: [],
      preferences: DEFAULT_PROACTIVE_PREFERENCES,
      now: NOW,
    },
    OPTIONS,
  );
  assert.equal(decision.action, "accept");
  if (decision.action !== "accept") return;
  assert.equal(Date.parse(decision.expiresAt) - Date.parse(decision.dueAt), 24 * 60 * 60 * 1_000);
});

function makeProposal(): InitiativeGoalProposal {
  return {
    title: "店を調べる",
    rationale: "昨日の会話で店の話をした",
    plan: "好みに合う店を3軒調べて返す",
    dueAt: "2026-11-22T12:00:00+09:00",
    risk: "low",
    delivery: "attach",
    sourceMessageIds: ["m1"],
  };
}

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
    dueAt: "2026-11-22T12:00:00Z",
    expiresAt: "2026-11-23T12:00:00Z",
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
