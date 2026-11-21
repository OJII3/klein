import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROACTIVE_PREFERENCES } from "@modules/proactivity/domain/proactive-preference";

import type { InitiativeGoal } from "../domain/initiative-goal";
import { buildPlannerPrompt, parseInitiativePlanResponse } from "./pi-initiative-planner";

test("parses goals from a JSON response", () => {
  const goals = parseInitiativePlanResponse(
    JSON.stringify({
      goals: [
        {
          title: "店を調べる",
          rationale: "店の話をしていた",
          plan: "好みに合う店を3軒調べる",
          dueAt: "2026-11-22T12:00:00+09:00",
          risk: "low",
          delivery: "attach",
          sourceMessageIds: ["m1"],
        },
      ],
    }),
    2,
  );

  assert.equal(goals.length, 1);
  assert.equal(goals[0]?.title, "店を調べる");
  assert.deepEqual(goals[0]?.sourceMessageIds, ["m1"]);
});

test("accepts snake_case fields and code fences", () => {
  const goals = parseInitiativePlanResponse(
    "```json\n" +
      JSON.stringify({
        goals: [
          {
            title: "サンプルを作る",
            rationale: "試したいと言っていた",
            plan: "一時ディレクトリでサンプルを作る",
            due_at: "2026-11-22T18:00:00+09:00",
            expires_at: "2026-11-23T18:00:00+09:00",
            risk: "low",
            source_message_ids: ["m2"],
          },
        ],
      }) +
      "\n```",
    2,
  );

  assert.equal(goals[0]?.dueAt, "2026-11-22T18:00:00+09:00");
  assert.equal(goals[0]?.expiresAt, "2026-11-23T18:00:00+09:00");
  assert.deepEqual(goals[0]?.sourceMessageIds, ["m2"]);
});

test("limits the number of parsed goals", () => {
  const goals = parseInitiativePlanResponse(
    JSON.stringify({
      goals: [makeProposalJson("a"), makeProposalJson("b"), makeProposalJson("c")],
    }),
    2,
  );
  assert.deepEqual(
    goals.map((goal) => goal.title),
    ["a", "b"],
  );
});

test("rejects invalid JSON and invalid goals", () => {
  assert.throws(() => parseInitiativePlanResponse("not json", 2), /JSON ではありません/u);
  assert.throws(
    () => parseInitiativePlanResponse(JSON.stringify({ goals: [{ title: "x" }] }), 2),
    /必須の文字列/u,
  );
});

test("includes the conversation and active goals in the planner prompt", () => {
  const now = Date.parse("2026-11-21T12:00:00+09:00");
  const prompt = buildPlannerPrompt({
    channelId: "channel-1",
    accessScope: "owner:1",
    now,
    messages: [
      { id: "m1", role: "user", text: "この店気になる", timestamp: "2026-11-21T11:50:00+09:00" },
    ],
    existingGoals: [makeGoal()],
    preferences: DEFAULT_PROACTIVE_PREFERENCES,
    userMemory: "甘いものが好き",
    sharedMemory: "駅前の再開発が進んでいる",
    maxGoals: 2,
  });

  assert.match(prompt.userPrompt, /m1/u);
  assert.match(prompt.userPrompt, /店を調べる/u);
  assert.match(prompt.userPrompt, /甘いものが好き/u);
  assert.match(prompt.userPrompt, /駅前の再開発/u);
  assert.match(prompt.userPrompt, /At most 2 goals/u);
});

function makeProposalJson(title: string): Record<string, unknown> {
  return {
    title,
    rationale: "理由",
    plan: "計画",
    dueAt: "2026-11-22T12:00:00+09:00",
    risk: "low",
  };
}

function makeGoal(): InitiativeGoal {
  return {
    version: 1,
    id: "goal-1",
    channelId: "channel-1",
    accessScope: "owner:1",
    title: "店を調べる",
    rationale: "理由",
    source: { kind: "conversation", messageIds: ["m1"] },
    plan: "計画",
    dueAt: "2026-11-22T12:00:00+09:00",
    expiresAt: "2026-11-23T12:00:00+09:00",
    risk: "low",
    status: "scheduled",
    dedupeKey: "dedupe",
    createdBy: "planner",
    createdAt: "2026-11-21T12:00:00+09:00",
    updatedAt: "2026-11-21T12:00:00+09:00",
  };
}
