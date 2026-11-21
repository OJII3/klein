import assert from "node:assert/strict";
import { join } from "node:path";

import { test } from "bun:test";

import type { WorkerControl, WorkerInfo } from "@agents/core/worker-agent";
import { InMemoryScheduledTaskStore } from "@agents/testing/test-stubs";
import type {
  ReminderTask,
  ScheduledTask,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import { createTempDir } from "../../../testing/temp-dir";

import type { FollowUp } from "../domain/follow-up";
import type { ProactivePolicyDefaults } from "../domain/proactive-delivery-policy";
import { markSignalSurfaced, type ProactiveSignal } from "../domain/proactive-signal";
import { FileFollowUpStore } from "../infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "../infrastructure/file-proactive-preference-store";
import { FileProactiveSignalStore } from "../infrastructure/file-proactive-signal-store";
import { ProactiveCoordinator, type ProactiveCoordinatorOptions } from "./proactive-coordinator";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const CREATED_AT = "2026-11-20T00:00:00.000Z";
const OWNER_TARGET = { channelId: "channel-a", accessScope: "owner:123" } as const;
const DEFAULT_POLICY_DEFAULTS: ProactivePolicyDefaults = {
  defaultMode: "attach",
  maxPerDay: 3,
  publicChannels: false,
};

const watchTask: WatchTask = {
  kind: "watch",
  id: "watch-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  createdAt: CREATED_AT,
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-11-20T00:05:00.000Z",
  name: "在庫監視",
  script: "silent();",
  args: [],
  message: "在庫を確認してください。",
  enabled: true,
  consecutiveFailures: 0,
};

const reminderTask: ReminderTask = {
  kind: "reminder",
  id: "reminder-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  createdAt: CREATED_AT,
  schedule: { type: "every", minutes: 30 },
  nextRunAt: "2026-11-20T00:30:00.000Z",
  message: "定例会",
};

function workerInfo(id: string, status: WorkerInfo["status"] = "running"): WorkerInfo {
  return {
    id,
    prompt: "作業",
    status,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function followUp(overrides: Partial<FollowUp> & Pick<FollowUp, "id">): FollowUp {
  return {
    version: 1,
    channelId: "channel-a",
    accessScope: "owner:123",
    subject: "天気を確認する",
    watcher: { kind: "watch", id: "watch-1" },
    cadenceLabel: "5分ごと",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeSignal(id: string, overrides: Partial<ProactiveSignal> = {}): ProactiveSignal {
  return {
    version: 1,
    id,
    channelId: "channel-a",
    accessScope: "owner:123",
    audience: "owner",
    source: { kind: "watch", ref: "watch-1" },
    topic: "在庫監視",
    summary: `候補 ${id}`,
    urgency: "today",
    dedupeKey: `dedupe-${id}`,
    observedAt: CREATED_AT,
    status: "queued",
    ...overrides,
  };
}

async function withCoordinator(
  run: (harness: {
    readonly coordinator: ProactiveCoordinator;
    readonly preferenceStore: FileProactivePreferenceStore;
    readonly followUpStore: FileFollowUpStore;
    readonly signalStore: FileProactiveSignalStore;
    readonly scheduledTaskStore: InMemoryScheduledTaskStore;
    readonly workers: Pick<WorkerControl, "list">;
  }) => Promise<void>,
  options: {
    readonly tasks?: readonly ScheduledTask[];
    readonly workerInfos?: readonly WorkerInfo[];
    readonly now?: number;
    readonly defaults?: ProactivePolicyDefaults;
    readonly onSignalSurfaced?: ProactiveCoordinatorOptions["onSignalSurfaced"];
  } = {},
): Promise<void> {
  await using temp = await createTempDir("klein-proactive-coordinator-");
  const preferenceStore = new FileProactivePreferenceStore(join(temp.path, "preferences"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const signalStore = new FileProactiveSignalStore(join(temp.path, "signals"));
  const scheduledTaskStore = new InMemoryScheduledTaskStore(options.tasks ?? []);
  const workers: Pick<WorkerControl, "list"> = {
    list: () => options.workerInfos ?? [],
  };
  const coordinator = new ProactiveCoordinator({
    preferenceStore,
    followUpStore,
    signalStore,
    scheduledTaskStore,
    workers,
    defaults: options.defaults ?? DEFAULT_POLICY_DEFAULTS,
    ...(options.onSignalSurfaced ? { onSignalSurfaced: options.onSignalSurfaced } : {}),
    now: () => options.now ?? NOW,
  });

  await run({
    coordinator,
    preferenceStore,
    followUpStore,
    signalStore,
    scheduledTaskStore,
    workers,
  });
}

test("returns preferences for each user and public channel separately", async () => {
  await withCoordinator(async ({ coordinator, preferenceStore }) => {
    const empty = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "owner:123",
    });
    assert.deepEqual(empty, {});

    await preferenceStore.update(OWNER_TARGET, { kind: "add_note", text: "作業中は短く" });

    const owner = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "owner:123",
    });
    assert.match(owner.preferences ?? "", /# Proactive preferences/u);
    assert.match(owner.preferences ?? "", /作業中は短く/u);

    const publicChannel = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "public",
    });
    assert.equal(publicChannel.preferences, undefined);

    await preferenceStore.update(
      { channelId: "channel-a", accessScope: "public" },
      { kind: "add_note", text: "チャンネルの好み" },
    );
    const configuredPublic = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "public",
    });
    assert.match(configuredPublic.preferences ?? "", /チャンネルの好み/u);
    assert.doesNotMatch(configuredPublic.preferences ?? "", /作業中は短く/u);

    const linkedUser = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "user:456",
    });
    assert.equal(linkedUser.preferences, undefined);
  });
});

test("expires overdue follow-ups and drops terminal statuses", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      await followUpStore.create(
        followUp({ id: "overdue", expiresAt: "2026-11-20T00:00:00.000Z" }),
      );
      await followUpStore.create(followUp({ id: "done", status: "done" }));
      await followUpStore.create(followUp({ id: "dismissed", status: "dismissed" }));

      const context = await coordinator.getContext({
        channelId: "channel-a",
        accessScope: "owner:123",
      });
      assert.equal(context.waitingOn, undefined);
      assert.equal((await followUpStore.get("overdue"))?.status, "expired");
      assert.deepEqual(await coordinator.listFollowUps("channel-a", "owner:123"), []);
    },
    { tasks: [watchTask] },
  );
});

test("marks follow-ups orphaned when their watch or worker disappears", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      await followUpStore.create(followUp({ id: "missing-watch", subject: "消えた監視" }));
      await followUpStore.create(
        followUp({
          id: "failed-task",
          subject: "失敗したワーカー",
          watcher: { kind: "worker", id: "worker-1" },
          cadenceLabel: "ワーカーの完了時",
        }),
      );

      const context = await coordinator.getContext({
        channelId: "channel-a",
        accessScope: "owner:123",
      });

      assert.equal((await followUpStore.get("missing-watch"))?.status, "orphaned");
      assert.equal((await followUpStore.get("failed-task"))?.status, "orphaned");
      assert.equal(context.waitingOn?.split("\n").length, 2);
      assert.match(context.waitingOn ?? "", /消えた監視/u);
      assert.match(context.waitingOn ?? "", /失敗したワーカー/u);
      assert.match(context.waitingOn ?? "", /監視なし/u);
    },
    { workerInfos: [workerInfo("worker-1", "failed")] },
  );
});

test("formats at most eight waiting follow-ups with their status", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      for (let index = 0; index < 10; index += 1) {
        await followUpStore.create(
          followUp({
            id: `follow-${index}`,
            subject: `確認 ${index}`,
            createdAt: new Date(NOW + index).toISOString(),
            updatedAt: new Date(NOW + index).toISOString(),
          }),
        );
      }

      const context = await coordinator.getContext({
        channelId: "channel-a",
        accessScope: "owner:123",
      });
      const lines = context.waitingOn?.split("\n") ?? [];
      assert.equal(lines.length, 8);
      assert.match(lines[0] ?? "", /確認 0/u);
      assert.match(lines[7] ?? "", /確認 7/u);
    },
    { tasks: [watchTask] },
  );
});

test("rejects follow-ups for a missing or stopped watcher", async () => {
  await withCoordinator(
    async ({ coordinator }) => {
      await assert.rejects(
        coordinator.createFollowUp({
          channelId: "channel-a",
          accessScope: "owner:123",
          subject: "天気を確認する",
          watcher: { kind: "reminder", id: "missing" },
        }),
        /見つかりません/u,
      );

      await assert.rejects(
        coordinator.createFollowUp({
          channelId: "channel-a",
          accessScope: "owner:123",
          watcher: { kind: "watch", id: "watch-1" },
          subject: " ",
        }),
        /追跡する内容/u,
      );

      await assert.rejects(
        coordinator.createFollowUp({
          channelId: "channel-a",
          accessScope: "owner:123",
          subject: "天気を確認する",
          watcher: { kind: "watch", id: "watch-1" },
        }),
        /停止中/u,
      );
    },
    { tasks: [{ ...watchTask, enabled: false }] },
  );
});

test("creates follow-ups with the schedule label and avoids duplicate registration", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      const input = {
        channelId: "channel-a",
        accessScope: "owner:123" as const,
        subject: " 定例会を確認する ",
        watcher: { kind: "reminder", id: "reminder-1" } as const,
      };
      const created = await coordinator.createFollowUp(input);
      const duplicate = await coordinator.createFollowUp(input);

      assert.equal(created.subject, "定例会を確認する");
      assert.equal(created.cadenceLabel, "30分ごと");
      assert.equal(duplicate.id, created.id);
      assert.deepEqual(await followUpStore.listForScope("channel-a", "owner:123"), [created]);

      const workerFollowUp = await coordinator.createFollowUp({
        channelId: "channel-a",
        accessScope: "owner:123",
        subject: "作業の結果を知らせる",
        watcher: { kind: "worker", id: "worker-1" },
      });
      assert.equal(workerFollowUp.cadenceLabel, "ワーカーの完了時");
    },
    { tasks: [reminderTask], workerInfos: [workerInfo("worker-1")] },
  );
});

test("closes only follow-ups in the same channel and scope", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      await followUpStore.create(followUp({ id: "close-me" }));

      assert.equal(
        await coordinator.closeFollowUp("channel-b", "owner:123", "close-me", "done"),
        false,
      );
      assert.equal(
        await coordinator.closeFollowUp("channel-a", "public", "close-me", "done"),
        false,
      );
      assert.equal(
        await coordinator.closeFollowUp("channel-a", "owner:123", "missing", "done"),
        false,
      );
      assert.equal(
        await coordinator.closeFollowUp("channel-a", "owner:123", "close-me", "done"),
        true,
      );
      assert.equal((await followUpStore.get("close-me"))?.status, "done");

      await followUpStore.create(followUp({ id: "dismiss-me" }));
      assert.equal(
        await coordinator.closeFollowUp("channel-a", "owner:123", "dismiss-me", "dismissed"),
        true,
      );
      assert.equal((await followUpStore.get("dismiss-me"))?.status, "dismissed");
      assert.deepEqual(await coordinator.listFollowUps("channel-a", "owner:123"), []);
    },
    { tasks: [watchTask] },
  );
});

test("lists queued signals in scope and expires overdue ones", async () => {
  await withCoordinator(async ({ coordinator, signalStore }) => {
    await signalStore.create(makeSignal("queued", { delivery: { mode: "attach" } }));
    await signalStore.create(
      makeSignal("expired", {
        expiresAt: new Date(NOW).toISOString(),
        delivery: { mode: "attach" },
      }),
    );
    await signalStore.create(
      makeSignal("other-channel", {
        channelId: "channel-b",
        delivery: { mode: "attach" },
      }),
    );
    await signalStore.create(
      makeSignal("other-scope", {
        accessScope: "public",
        audience: "public",
        delivery: { mode: "attach" },
      }),
    );

    const visible = await coordinator.listQueuedSignals("channel-a", "owner:123");

    assert.deepEqual(
      visible.map((signal) => signal.id),
      ["queued"],
    );
    assert.equal((await signalStore.get("expired"))?.status, "expired");
    assert.equal((await signalStore.get("other-channel"))?.status, "queued");
    assert.equal((await signalStore.get("other-scope"))?.status, "queued");
  });
});

test("dismisses only signals in the same channel and scope", async () => {
  await withCoordinator(async ({ coordinator, signalStore }) => {
    await signalStore.create(makeSignal("dismiss-me", { delivery: { mode: "attach" } }));

    assert.equal(await coordinator.dismissSignal("channel-b", "owner:123", "dismiss-me"), false);
    assert.equal(await coordinator.dismissSignal("channel-a", "public", "dismiss-me"), false);
    assert.equal(await coordinator.dismissSignal("channel-a", "owner:123", "missing"), false);
    assert.equal((await signalStore.get("dismiss-me"))?.status, "queued");

    assert.equal(await coordinator.dismissSignal("channel-a", "owner:123", "dismiss-me"), true);
    assert.equal((await signalStore.get("dismiss-me"))?.status, "dismissed");
    assert.deepEqual(await coordinator.listQueuedSignals("channel-a", "owner:123"), []);
  });
});

test("turns a watch wake into a queued signal and ignores a duplicate", async () => {
  await withCoordinator(async ({ coordinator, signalStore }) => {
    const first = await coordinator.ingestWatchSignal({
      watch: watchTask,
      output: "在庫が3個になりました",
      now: NOW,
    });
    assert.deepEqual(first.decision, { mode: "attach", reason: "default-mode" });
    assert.equal(first.signal.status, "queued");
    assert.deepEqual(first.signal.delivery, { mode: "attach" });
    assert.deepEqual(first.signal.evidence, { text: "在庫が3個になりました" });
    assert.equal(first.signal.audience, "owner");
    assert.equal(first.signal.urgency, "today");
    assert.equal(first.signal.expiresAt, "2026-11-27T12:00:00.000Z");
    assert.deepEqual(await signalStore.get(first.signal.id), first.signal);

    const duplicate = await coordinator.ingestWatchSignal({
      watch: watchTask,
      output: "在庫が3個になりました",
      now: NOW + 60_000,
    });
    assert.deepEqual(duplicate.decision, { mode: "silent", reason: "duplicate" });
    assert.equal(duplicate.signal.id, first.signal.id);
    assert.deepEqual(await signalStore.listAllQueued(), [first.signal]);
  });
});

test("keeps urgent wakes interruptible and holds normal wakes as attach", async () => {
  await withCoordinator(async ({ coordinator, signalStore }) => {
    const urgent = await coordinator.ingestWatchSignal({
      watch: { ...watchTask, priority: "urgent" },
      output: "至急",
      now: NOW,
    });
    assert.deepEqual(urgent.decision, { mode: "interrupt", reason: "urgency-now" });
    assert.equal(urgent.signal.urgency, "now");
    assert.equal((await signalStore.get(urgent.signal.id))?.status, "queued");

    const normal = await coordinator.ingestWatchSignal({
      watch: { ...watchTask, id: "watch-2" },
      output: "あとで",
      now: NOW,
    });
    assert.deepEqual(normal.decision, { mode: "attach", reason: "default-mode" });
    assert.equal((await signalStore.get(normal.signal.id))?.status, "queued");
  });
});

test("delivers a public watch signal even when public channels are disabled", async () => {
  await withCoordinator(async ({ coordinator, signalStore, followUpStore }) => {
    await followUpStore.create(followUp({ id: "public-follow-up" }));

    const result = await coordinator.ingestWatchSignal({
      watch: { ...watchTask, accessScope: "public" },
      output: "公開",
      now: NOW,
    });

    assert.deepEqual(result.decision, { mode: "attach", reason: "default-mode" });
    assert.equal(result.signal.audience, "public");
    const stored = await signalStore.get(result.signal.id);
    assert.equal(stored?.status, "queued");
    assert.deepEqual(stored?.delivery, { mode: "attach" });
    assert.equal((await followUpStore.get("public-follow-up"))?.status, "active");
  });
});

test("applies the preferences of the linked user who owns the watch", async () => {
  await withCoordinator(async ({ coordinator, preferenceStore, signalStore }) => {
    await preferenceStore.update(
      { channelId: "channel-a", accessScope: "user:456" },
      { kind: "set_topic", topic: "在庫監視", mode: "mute" },
    );

    const result = await coordinator.ingestWatchSignal({
      watch: { ...watchTask, accessScope: "user:456" },
      output: "在庫が3個になりました",
      now: NOW,
    });

    assert.deepEqual(result.decision, { mode: "silent", reason: "topic-muted" });
    assert.equal((await signalStore.get(result.signal.id))?.status, "surfaced");
    assert.deepEqual((await signalStore.get(result.signal.id))?.delivery, {
      mode: "silent",
      surfacedAt: new Date(NOW).toISOString(),
    });
  });
});

test("marks signals surfaced and notifies only active follow-ups watching them", async () => {
  await withCoordinator(async ({ coordinator, signalStore, followUpStore }) => {
    await followUpStore.create(followUp({ id: "active" }));
    await followUpStore.create(followUp({ id: "already-done", status: "done" }));
    const signal = makeSignal("signal-1");

    await coordinator.markSignalsSurfaced([signal], "attach", NOW);

    const stored = await signalStore.get(signal.id);
    assert.equal(stored?.status, "surfaced");
    assert.deepEqual(stored?.delivery, {
      mode: "attach",
      surfacedAt: new Date(NOW).toISOString(),
    });
    const active = await followUpStore.get("active");
    assert.equal(active?.status, "notified");
    assert.equal(active?.lastNotifiedAt, new Date(NOW).toISOString());
    assert.equal((await followUpStore.get("already-done"))?.status, "done");

    await followUpStore.create(followUp({ id: "silent-follow-up" }));
    await coordinator.markSignalsSurfaced([makeSignal("signal-2")], "silent", NOW);
    assert.equal((await followUpStore.get("silent-follow-up"))?.status, "active");
  });
});

test("notifies the surfaced hook for goal signals but not for silent signals", async () => {
  const surfaced: { readonly id: string; readonly mode: string }[] = [];
  await withCoordinator(
    async ({ coordinator }) => {
      await coordinator.markSignalsSurfaced(
        [makeSignal("goal-1", { source: { kind: "goal", ref: "goal-1" } })],
        "attach",
        NOW,
      );
      assert.deepEqual(surfaced, [{ id: "goal-1", mode: "attach" }]);

      await coordinator.markSignalsSurfaced(
        [makeSignal("goal-2", { source: { kind: "goal", ref: "goal-2" } })],
        "silent",
        NOW,
      );
      assert.deepEqual(surfaced, [{ id: "goal-1", mode: "attach" }]);
    },
    {
      onSignalSurfaced: async (signal, mode) => {
        surfaced.push({ id: signal.id, mode });
      },
    },
  );
});

test("attaches up to five queued signals and expires overdue ones", async () => {
  await withCoordinator(async ({ coordinator, signalStore }) => {
    await signalStore.create(
      makeSignal("expired", {
        expiresAt: new Date(NOW - 1).toISOString(),
        observedAt: "2026-11-19T23:00:00.000Z",
        delivery: { mode: "attach" },
      }),
    );
    for (let index = 0; index < 6; index += 1) {
      await signalStore.create(
        makeSignal(`attach-${index}`, {
          summary: `候補 ${index}`,
          delivery: { mode: "attach" },
          observedAt: new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString(),
        }),
      );
    }

    const context = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "owner:123",
    });
    const lines = context.pendingSignals?.split("\n") ?? [];
    assert.equal(lines.length, 5);
    assert.match(lines[0] ?? "", /候補 0/u);
    assert.match(lines[4] ?? "", /候補 4/u);

    const consumed = await signalStore.get("attach-0");
    assert.equal(consumed?.status, "surfaced");
    assert.deepEqual(consumed?.delivery, {
      mode: "attach",
      surfacedAt: new Date(NOW).toISOString(),
    });
    assert.equal((await signalStore.get("attach-5"))?.status, "queued");
    assert.equal((await signalStore.get("expired"))?.status, "expired");
  });
});

const DIGEST_DEFAULTS: ProactivePolicyDefaults = {
  ...DEFAULT_POLICY_DEFAULTS,
  digestAt: "09:00",
};
const AFTER_DIGEST = Date.parse("2026-11-20T01:00:00.000Z");
const BEFORE_DIGEST = Date.parse("2026-11-19T23:00:00.000Z");

function digestSignal(
  id: string,
  observedAt: string,
  overrides: Partial<ProactiveSignal> = {},
): ProactiveSignal {
  return makeSignal(id, {
    observedAt,
    delivery: { mode: "digest" },
    ...overrides,
  });
}

test("waits for the digest time before collecting digest signals", async () => {
  await withCoordinator(
    async ({ coordinator, signalStore }) => {
      await signalStore.create(digestSignal("early", "2026-11-19T20:00:00.000Z"));

      assert.deepEqual(await coordinator.collectDueDigests(BEFORE_DIGEST), []);
      assert.equal((await signalStore.get("early"))?.status, "queued");
    },
    { defaults: DIGEST_DEFAULTS },
  );
});

test("collects only signals observed before today's digest time", async () => {
  await withCoordinator(
    async ({ coordinator, signalStore }) => {
      await signalStore.create(digestSignal("early", "2026-11-19T23:30:00.000Z"));
      await signalStore.create(digestSignal("late", "2026-11-20T00:30:00.000Z"));

      const batches = await coordinator.collectDueDigests(AFTER_DIGEST);

      assert.equal(batches.length, 1);
      assert.equal(batches[0]?.channelId, "channel-a");
      assert.equal(batches[0]?.accessScope, "owner:123");
      assert.deepEqual(
        batches[0]?.signals.map((signal) => signal.id),
        ["early"],
      );
      assert.match(batches[0]?.text ?? "", /まとめて伝える候補があります/u);
      assert.match(batches[0]?.text ?? "", /候補 early/u);
      assert.doesNotMatch(batches[0]?.text ?? "", /候補 late/u);

      const surfaced = await signalStore.get("early");
      assert.equal(surfaced?.status, "surfaced");
      assert.deepEqual(surfaced?.delivery, {
        mode: "digest",
        surfacedAt: new Date(AFTER_DIGEST).toISOString(),
      });
      assert.equal((await signalStore.get("late"))?.status, "queued");
    },
    { defaults: DIGEST_DEFAULTS },
  );
});

test("expires overdue digest signals and keeps the rest", async () => {
  await withCoordinator(
    async ({ coordinator, signalStore }) => {
      await signalStore.create(
        digestSignal("expired", "2026-11-19T20:00:00.000Z", {
          expiresAt: new Date(AFTER_DIGEST - 1).toISOString(),
        }),
      );
      await signalStore.create(digestSignal("valid", "2026-11-19T21:00:00.000Z"));

      const batches = await coordinator.collectDueDigests(AFTER_DIGEST);

      assert.deepEqual(
        batches[0]?.signals.map((signal) => signal.id),
        ["valid"],
      );
      assert.equal((await signalStore.get("expired"))?.status, "expired");
    },
    { defaults: DIGEST_DEFAULTS },
  );
});

test("collects one digest batch per channel and access scope", async () => {
  await withCoordinator(
    async ({ coordinator, signalStore }) => {
      await signalStore.create(digestSignal("a-1", "2026-11-19T20:00:00.000Z"));
      await signalStore.create(digestSignal("a-2", "2026-11-19T21:00:00.000Z"));
      await signalStore.create(
        digestSignal("a-public", "2026-11-19T22:00:00.000Z", {
          accessScope: "public",
          audience: "public",
        }),
      );
      await signalStore.create(
        digestSignal("b-1", "2026-11-19T23:00:00.000Z", {
          channelId: "channel-b",
          dedupeKey: "dedupe-b-1",
        }),
      );

      const batches = await coordinator.collectDueDigests(AFTER_DIGEST);
      const byKey = new Map(
        batches.map((batch) => [`${batch.channelId}:${batch.accessScope}`, batch]),
      );

      assert.equal(batches.length, 3);
      assert.deepEqual(
        byKey.get("channel-a:owner:123")?.signals.map((signal) => signal.id),
        ["a-1", "a-2"],
      );
      assert.equal(byKey.get("channel-a:owner:123")?.text.split("\n").length, 3);
      assert.deepEqual(
        byKey.get("channel-a:public")?.signals.map((signal) => signal.id),
        ["a-public"],
      );
      assert.deepEqual(
        byKey.get("channel-b:owner:123")?.signals.map((signal) => signal.id),
        ["b-1"],
      );
    },
    { defaults: DIGEST_DEFAULTS },
  );
});

test("uses the digest time from the preferences", async () => {
  await withCoordinator(
    async ({ coordinator, preferenceStore, signalStore }) => {
      await preferenceStore.update(OWNER_TARGET, {
        kind: "set_delivery",
        key: "digest_at",
        value: "08:00",
      });
      await signalStore.create(digestSignal("early", "2026-11-19T22:00:00.000Z"));

      const batches = await coordinator.collectDueDigests(BEFORE_DIGEST);

      assert.deepEqual(
        batches[0]?.signals.map((signal) => signal.id),
        ["early"],
      );
    },
    { defaults: DIGEST_DEFAULTS },
  );
});

test("completes active and notified follow-ups for a finished watcher", async () => {
  await withCoordinator(async ({ coordinator, followUpStore }) => {
    await followUpStore.create(
      followUp({ id: "active-reminder", watcher: { kind: "reminder", id: "reminder-1" } }),
    );
    await followUpStore.create(
      followUp({
        id: "notified-reminder",
        watcher: { kind: "reminder", id: "reminder-1" },
        status: "notified",
      }),
    );
    await followUpStore.create(
      followUp({
        id: "done-reminder",
        watcher: { kind: "reminder", id: "reminder-1" },
        status: "done",
      }),
    );
    await followUpStore.create(
      followUp({ id: "other-reminder", watcher: { kind: "reminder", id: "reminder-2" } }),
    );

    await coordinator.markWatcherCompleted("reminder", "reminder-1");

    assert.equal((await followUpStore.get("active-reminder"))?.status, "done");
    assert.equal((await followUpStore.get("notified-reminder"))?.status, "done");
    assert.equal((await followUpStore.get("done-reminder"))?.status, "done");
    assert.equal((await followUpStore.get("other-reminder"))?.status, "active");
  });
});

test("does not count silent deliveries toward the daily limit", async () => {
  await withCoordinator(
    async ({ coordinator, preferenceStore, signalStore }) => {
      await preferenceStore.update(OWNER_TARGET, {
        kind: "set_delivery",
        key: "max_per_day",
        value: "1",
      });
      await signalStore.create(markSignalSurfaced(makeSignal("silent-today"), "silent", NOW));

      const first = await coordinator.ingestWatchSignal({
        watch: watchTask,
        output: "一つ目",
        now: NOW,
      });
      assert.deepEqual(first.decision, { mode: "attach", reason: "default-mode" });

      await signalStore.create(markSignalSurfaced(makeSignal("attach-today"), "attach", NOW));
      const second = await coordinator.ingestWatchSignal({
        watch: { ...watchTask, id: "watch-2" },
        output: "二つ目",
        now: NOW,
      });
      assert.deepEqual(second.decision, { mode: "attach", reason: "daily-limit" });
    },
    { defaults: { ...DEFAULT_POLICY_DEFAULTS, maxPerDay: 5 } },
  );
});
