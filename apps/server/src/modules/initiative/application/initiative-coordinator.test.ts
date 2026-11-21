import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { WorkerStartInput } from "@agents/core/worker-agent";
import { DEFAULT_PROACTIVE_PREFERENCES } from "@modules/proactivity/domain/proactive-preference";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { AccessScope } from "@shared/access";

import { createTempDir } from "../../../testing/temp-dir";
import type { InitiativeGoal } from "../domain/initiative-goal";
import { FileInitiativeGoalStore } from "../infrastructure/file-initiative-goal-store";
import { FilePlannerStateStore } from "../infrastructure/file-planner-state-store";
import type { ResolvedInitiativeConfig } from "./initiative-config";
import { InitiativeCoordinator, type InitiativeCoordinatorOptions } from "./initiative-coordinator";

const NOW = Date.parse("2026-11-21T12:00:00+09:00");
const CHANNEL_ID = "channel-1";
const ACCESS_SCOPE: AccessScope = "owner:1";

test("creates a goal after idle planning and does not repeat the same messages", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW - 31 * 60 * 1_000),
    messages: [makeMessage("m1")],
    proposals: [makeProposal()],
  });

  await harness.coordinator.planDueChannels(NOW);

  const goals = await harness.goalStore.listForScope(CHANNEL_ID, ACCESS_SCOPE);
  assert.equal(goals.length, 1);
  assert.equal(goals[0]?.title, "店を調べる");
  assert.equal(goals[0]?.status, "scheduled");
  assert.equal(goals[0]?.createdBy, "planner");
  assert.equal(harness.plannerCalls, 1);

  await harness.coordinator.planDueChannels(NOW);
  assert.equal(harness.plannerCalls, 1);
});

test("does not plan while the channel is still active", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW - 10 * 60 * 1_000),
    messages: [makeMessage("m1")],
    proposals: [makeProposal()],
  });

  await harness.coordinator.planDueChannels(NOW);

  assert.equal(harness.plannerCalls, 0);
  assert.equal((await harness.goalStore.listAll()).length, 0);
});

test("starts a worker for a due goal and records its id", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  const goal = makeGoal({
    id: "goal-1",
    dueAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
  });
  await harness.goalStore.create(goal);

  await harness.coordinator.deliverDueGoals(NOW);

  const updated = await harness.goalStore.get("goal-1");
  assert.equal(updated?.status, "running");
  assert.equal(updated?.workerId, "worker-1");
  assert.equal(harness.startedWorkers.length, 1);
  assert.match(harness.startedWorkers[0]?.prompt ?? "", /店を調べる/u);
  assert.equal(harness.startedWorkers[0]?.closeAfterResult, true);
});

test("turns a worker result into a proactive signal and marks the goal ready", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  const goal = makeGoal({
    id: "goal-1",
    status: "running",
    workerId: "worker-1",
  });
  await harness.goalStore.create(goal);

  const result = await harness.coordinator.handleWorkerResult({
    workerId: "worker-1",
    status: "completed",
    text: "店を3軒見つけた",
  });

  if (!result || "ignored" in result) {
    assert.fail("expected an initiative result");
  }
  assert.equal(result.decision.mode, "attach");
  assert.equal(result?.signal.id, "signal-1");
  const updated = await harness.goalStore.get("goal-1");
  assert.equal(updated?.status, "ready");
  assert.equal(updated?.signalId, "signal-1");
});

test("ignores a worker result after the goal is dismissed", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      status: "dismissed",
      workerId: "worker-1",
    }),
  );

  const result = await harness.coordinator.handleWorkerResult({
    workerId: "worker-1",
    status: "completed",
    text: "遅れて届いた結果",
  });

  assert.deepEqual(result, { ignored: true, reason: "goal is dismissed" });
});

test("creates a goal from the conversation tool and rejects a duplicate", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });

  const goal = await harness.coordinator.createGoalFromConversation({
    channelId: CHANNEL_ID,
    accessScope: ACCESS_SCOPE,
    title: "店を調べる",
    rationale: "店の話をしていた",
    plan: "好みに合う店を3軒調べる",
    dueAt: "2026-11-22T12:00:00+09:00",
    now: NOW,
  });
  assert.equal(goal.createdBy, "conversation");

  await assert.rejects(
    harness.coordinator.createGoalFromConversation({
      channelId: CHANNEL_ID,
      accessScope: ACCESS_SCOPE,
      title: "店を調べる",
      rationale: "店の話をしていた",
      plan: "好みに合う店を3軒調べる",
      dueAt: "2026-11-22T12:00:00+09:00",
      now: NOW,
    }),
    /duplicate goal/u,
  );
});

test("stores goals without executing them in propose mode", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
    approval: "propose",
  });
  const goal = makeGoal({
    id: "goal-1",
    dueAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
  });
  await harness.goalStore.create(goal);

  await harness.coordinator.deliverDueGoals(NOW);

  assert.equal(harness.startedWorkers.length, 0);
  assert.equal((await harness.goalStore.get("goal-1"))?.status, "scheduled");
});

interface Harness {
  readonly coordinator: InitiativeCoordinator;
  readonly goalStore: FileInitiativeGoalStore;
  readonly plannerCalls: number;
  readonly startedWorkers: WorkerStartInput[];
}

async function createHarness(
  directory: string,
  input: {
    readonly channelState: ReturnType<typeof makeChannelState>;
    readonly messages: readonly ReturnType<typeof makeMessage>[];
    readonly proposals: readonly ReturnType<typeof makeProposal>[];
    readonly approval?: ResolvedInitiativeConfig["approval"];
  },
): Promise<Harness> {
  const goalStore = new FileInitiativeGoalStore(join(directory, "goals"));
  const plannerStateStore = new FilePlannerStateStore(join(directory, "planner"));
  const startedWorkers: WorkerStartInput[] = [];
  let plannerCalls = 0;

  const options: InitiativeCoordinatorOptions = {
    config: makeConfig(directory, input.approval),
    goalStore,
    plannerStateStore,
    channelStateStore: {
      async list() {
        return [input.channelState];
      },
    },
    transcriptReader: {
      async read() {
        return input.messages;
      },
    },
    preferenceStore: {
      async read() {
        return DEFAULT_PROACTIVE_PREFERENCES;
      },
      async list() {
        return [];
      },
      async update() {
        return DEFAULT_PROACTIVE_PREFERENCES;
      },
    },
    planner: {
      async plan() {
        plannerCalls += 1;
        return input.proposals;
      },
    },
    proactive: {
      async ingestGoalResult() {
        return {
          decision: { mode: "attach" as const, reason: "test" },
          signal: makeSignal(),
        };
      },
      async dismissSignal() {
        return false;
      },
    },
    workers: {
      async start(workerInput) {
        startedWorkers.push(workerInput);
        return "worker-1";
      },
    },
    operatingState: {
      isActive() {
        return true;
      },
    },
    ownerUserId: "1",
    now: () => NOW,
  };

  return {
    coordinator: new InitiativeCoordinator(options),
    goalStore,
    get plannerCalls() {
      return plannerCalls;
    },
    startedWorkers,
  };
}

function makeConfig(
  directory: string,
  approval: ResolvedInitiativeConfig["approval"] = "auto",
): ResolvedInitiativeConfig {
  return {
    enabled: true,
    goalsDirectory: join(directory, "goals"),
    plannerStateDirectory: join(directory, "planner"),
    llm: { provider: "opencode-go", model: "test" },
    planAfterIdleMinutes: 30,
    planWithinHours: 48,
    maxMessages: 80,
    maxPlansPerDay: 12,
    maxGoalsPerDay: 4,
    maxActiveGoals: 3,
    maxGoalsPerPlan: 2,
    approval,
  };
}

function makeChannelState(lastActivityAt: number) {
  return {
    conversationKey: { kind: "discord" as const, channelId: CHANNEL_ID },
    accessScope: ACCESS_SCOPE,
    sessionKey: "discord-channel:channel-1:owner:1",
    lastActivityAt,
    lastRotationDate: "2026-11-21T12",
    hasActivitySinceRotation: true,
  };
}

function makeMessage(id: string) {
  return {
    id,
    role: "user" as const,
    text: "店を調べたい",
    timestamp: new Date(NOW - 60 * 60 * 1_000).toISOString(),
  };
}

function makeProposal() {
  return {
    title: "店を調べる",
    rationale: "昨日の会話で店の話をした",
    plan: "好みに合う店を3軒調べて返す",
    dueAt: "2026-11-22T12:00:00+09:00",
    risk: "low" as const,
    delivery: "attach" as const,
    sourceMessageIds: ["m1"],
  };
}

function makeGoal(overrides: Partial<InitiativeGoal> = {}): InitiativeGoal {
  return {
    version: 1,
    id: "goal-1",
    channelId: CHANNEL_ID,
    accessScope: ACCESS_SCOPE,
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

function makeSignal(): ProactiveSignal {
  return {
    version: 1,
    id: "signal-1",
    channelId: CHANNEL_ID,
    accessScope: ACCESS_SCOPE,
    audience: "owner",
    source: { kind: "goal", ref: "goal-1" },
    topic: "店を調べる",
    summary: "店を3軒見つけた",
    urgency: "today",
    dedupeKey: "signal-dedupe",
    observedAt: new Date(NOW).toISOString(),
    status: "queued",
    delivery: { mode: "attach" },
  };
}
