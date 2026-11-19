import assert from "node:assert/strict";
import { join } from "node:path";

import { test } from "bun:test";

import type { AttachedTaskControl, AttachedTaskInfo } from "@agents/core/attached-agent";
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
import { ProactiveCoordinator } from "./proactive-coordinator";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const CREATED_AT = "2026-11-20T00:00:00.000Z";
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

function attachedTask(
  id: string,
  status: AttachedTaskInfo["status"] = "running",
): AttachedTaskInfo {
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
    readonly attachedTasks: Pick<AttachedTaskControl, "list">;
  }) => Promise<void>,
  options: {
    readonly tasks?: readonly ScheduledTask[];
    readonly attached?: readonly AttachedTaskInfo[];
    readonly now?: number;
    readonly defaults?: ProactivePolicyDefaults;
  } = {},
): Promise<void> {
  await using temp = await createTempDir("klein-proactive-coordinator-");
  const preferenceStore = new FileProactivePreferenceStore(join(temp.path, "preferences.md"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const signalStore = new FileProactiveSignalStore(join(temp.path, "signals"));
  const scheduledTaskStore = new InMemoryScheduledTaskStore(options.tasks ?? []);
  const attachedTasks: Pick<AttachedTaskControl, "list"> = {
    list: () => options.attached ?? [],
  };
  const coordinator = new ProactiveCoordinator({
    preferenceStore,
    followUpStore,
    signalStore,
    scheduledTaskStore,
    attachedTasks,
    defaults: options.defaults ?? DEFAULT_POLICY_DEFAULTS,
    now: () => options.now ?? NOW,
  });

  await run({
    coordinator,
    preferenceStore,
    followUpStore,
    signalStore,
    scheduledTaskStore,
    attachedTasks,
  });
}

test("returns preferences for the owner but not for public channels", async () => {
  await withCoordinator(async ({ coordinator, preferenceStore }) => {
    const empty = await coordinator.getContext({
      channelId: "channel-a",
      accessScope: "owner:123",
    });
    assert.deepEqual(empty, {});

    await preferenceStore.update({ kind: "add_note", text: "作業中は短く" });

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

test("marks follow-ups orphaned when their watch or task disappears", async () => {
  await withCoordinator(
    async ({ coordinator, followUpStore }) => {
      await followUpStore.create(followUp({ id: "missing-watch", subject: "消えた監視" }));
      await followUpStore.create(
        followUp({
          id: "failed-task",
          subject: "失敗したタスク",
          watcher: { kind: "task", id: "task-1" },
          cadenceLabel: "タスクの完了時",
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
      assert.match(context.waitingOn ?? "", /失敗したタスク/u);
      assert.match(context.waitingOn ?? "", /監視なし/u);
    },
    { attached: [attachedTask("task-1", "failed")] },
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

      const taskFollowUp = await coordinator.createFollowUp({
        channelId: "channel-a",
        accessScope: "owner:123",
        subject: "作業の結果を知らせる",
        watcher: { kind: "task", id: "task-1" },
      });
      assert.equal(taskFollowUp.cadenceLabel, "タスクの完了時");
    },
    { tasks: [reminderTask], attached: [attachedTask("task-1")] },
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

test("stores a silent signal as surfaced without notifying its follow-ups", async () => {
  await withCoordinator(async ({ coordinator, signalStore, followUpStore }) => {
    await followUpStore.create(followUp({ id: "public-follow-up" }));

    const result = await coordinator.ingestWatchSignal({
      watch: { ...watchTask, accessScope: "public" },
      output: "公開",
      now: NOW,
    });

    assert.deepEqual(result.decision, { mode: "silent", reason: "public-channel-disabled" });
    assert.equal(result.signal.audience, "public");
    const stored = await signalStore.get(result.signal.id);
    assert.equal(stored?.status, "surfaced");
    assert.equal(stored?.delivery?.mode, "silent");
    assert.equal((await followUpStore.get("public-follow-up"))?.status, "active");
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

test("does not count silent deliveries toward the daily limit", async () => {
  await withCoordinator(
    async ({ coordinator, preferenceStore, signalStore }) => {
      await preferenceStore.update({
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
