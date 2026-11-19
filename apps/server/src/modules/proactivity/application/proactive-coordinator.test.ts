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
import { FileFollowUpStore } from "../infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "../infrastructure/file-proactive-preference-store";
import { ProactiveCoordinator } from "./proactive-coordinator";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const CREATED_AT = "2026-11-20T00:00:00.000Z";

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

async function withCoordinator(
  run: (harness: {
    readonly coordinator: ProactiveCoordinator;
    readonly preferenceStore: FileProactivePreferenceStore;
    readonly followUpStore: FileFollowUpStore;
    readonly scheduledTaskStore: InMemoryScheduledTaskStore;
    readonly attachedTasks: Pick<AttachedTaskControl, "list">;
  }) => Promise<void>,
  options: {
    readonly tasks?: readonly ScheduledTask[];
    readonly attached?: readonly AttachedTaskInfo[];
    readonly now?: number;
  } = {},
): Promise<void> {
  await using temp = await createTempDir("klein-proactive-coordinator-");
  const preferenceStore = new FileProactivePreferenceStore(join(temp.path, "preferences.md"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const scheduledTaskStore = new InMemoryScheduledTaskStore(options.tasks ?? []);
  const attachedTasks: Pick<AttachedTaskControl, "list"> = {
    list: () => options.attached ?? [],
  };
  const coordinator = new ProactiveCoordinator({
    preferenceStore,
    followUpStore,
    scheduledTaskStore,
    attachedTasks,
    now: () => options.now ?? NOW,
  });

  await run({ coordinator, preferenceStore, followUpStore, scheduledTaskStore, attachedTasks });
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
