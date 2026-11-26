import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { WorkerInfo, WorkerStartInput } from "@agents/core/worker-agent";
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

test("plans again after the conversation session rotates", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const channelState = makeChannelState(NOW - 31 * 60 * 1_000);
  const messages = [makeMessage("m1")];
  const harness = await createHarness(temp.path, {
    channelState,
    messages,
    proposals: [makeProposal()],
  });

  await harness.coordinator.planDueChannels(NOW);
  assert.equal(harness.plannerCalls, 1);

  channelState.sessionKey = "discord-channel:channel-1:owner:1:rotation:2026-11-22T12";
  messages.push(makeMessage("m2"));
  await harness.coordinator.planDueChannels(NOW);

  assert.equal(harness.plannerCalls, 2);
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
  const started = harness.startedWorkers[0];
  assert.ok(started?.id);
  assert.equal(updated?.workerId, started.id);
  assert.equal(harness.startedWorkers.length, 1);
  assert.match(started.prompt, /店を調べる/u);
  assert.equal(started.closeAfterResult, true);
});

test("starts a goal inside its lead window but not before it", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      dueAt: new Date(NOW + 60 * 1_000).toISOString(),
      expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);

  assert.equal(harness.startedWorkers.length, 1);
  assert.equal((await harness.goalStore.get("goal-1"))?.status, "running");
});

test("waits for the lead window before starting a goal", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      dueAt: new Date(NOW + 3 * 60 * 1_000).toISOString(),
      expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);
  assert.equal(harness.startedWorkers.length, 0);

  await harness.coordinator.deliverDueGoals(NOW + 60 * 1_000);
  assert.equal(harness.startedWorkers.length, 1);
});

test("does not start a second worker on another tick inside the lead window", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      dueAt: new Date(NOW + 60 * 1_000).toISOString(),
      expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);
  await harness.coordinator.deliverDueGoals(NOW + 10 * 1_000);

  assert.equal(harness.startedWorkers.length, 1);
});

test("never starts an expired goal", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      dueAt: new Date(NOW - 30 * 1_000).toISOString(),
      expiresAt: new Date(NOW).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);

  assert.equal(harness.startedWorkers.length, 0);
  assert.equal((await harness.goalStore.get("goal-1"))?.status, "expired");
});

test("includes the premise and execution time in the goal worker prompt", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      createdAt: "2026-11-20T09:00:00.000Z",
      updatedAt: "2026-11-20T09:00:00.000Z",
      dueAt: new Date(NOW - 1_000).toISOString(),
      expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);

  const prompt = harness.startedWorkers[0]?.prompt ?? "";
  assert.match(prompt, /Premise captured at: 2026-11-20T09:00:00\.000Z \(JST: /u);
  assert.match(prompt, new RegExp(`Current time: ${new Date(NOW).toISOString()} \\(JST: `, "u"));
  assert.match(prompt, /Elapsed since premise capture: 18\.0 hours/u);
  assert.match(prompt, /Premise: invalidated \(<reason>\)/u);
  assert.match(prompt, /Premise: valid \(<what you checked>\)/u);
});

test("requeues a running goal whose worker is missing", async () => {
  await using temp = await createTempDir("klein-initiative-");
  const harness = await createHarness(temp.path, {
    channelState: makeChannelState(NOW),
    messages: [],
    proposals: [],
  });
  await harness.goalStore.create(
    makeGoal({
      id: "goal-1",
      status: "running",
      workerId: "missing-worker",
      updatedAt: new Date(NOW - 31 * 60 * 1_000).toISOString(),
    }),
  );

  await harness.coordinator.deliverDueGoals(NOW);

  const updated = await harness.goalStore.get("goal-1");
  assert.equal(updated?.status, "scheduled");
  assert.equal(updated?.workerId, undefined);
  assert.equal(harness.startedWorkers.length, 0);
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
  readonly runningWorkers: WorkerInfo[];
}

async function createHarness(
  directory: string,
  input: {
    readonly channelState: ReturnType<typeof makeChannelState>;
    readonly messages: readonly ReturnType<typeof makeMessage>[];
    readonly proposals: readonly ReturnType<typeof makeProposal>[];
    readonly approval?: ResolvedInitiativeConfig["approval"];
    readonly startLeadMs?: number;
  },
): Promise<Harness> {
  const goalStore = new FileInitiativeGoalStore(join(directory, "goals"));
  const plannerStateStore = new FilePlannerStateStore(join(directory, "planner"));
  const startedWorkers: WorkerStartInput[] = [];
  const runningWorkers: WorkerInfo[] = [];
  let plannerCalls = 0;

  const options: InitiativeCoordinatorOptions = {
    config: makeConfig(directory, input.approval, input.startLeadMs),
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
        const id = workerInput.id ?? "worker-1";
        runningWorkers.push({
          id,
          prompt: workerInput.prompt,
          status: "running",
          createdAt: new Date(NOW).toISOString(),
          updatedAt: new Date(NOW).toISOString(),
        });
        return id;
      },
      list() {
        return runningWorkers;
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
    runningWorkers,
  };
}

function makeConfig(
  directory: string,
  approval: ResolvedInitiativeConfig["approval"] = "auto",
  startLeadMs = 2 * 60 * 1_000,
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
    startLeadMs,
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
