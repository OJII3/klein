import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  formatJapanDateTime,
  formatSchedule,
  getNextRunAt,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  resolveSchedule,
  SCHEDULE_WEEKDAYS,
  type ScheduleInput,
  type StoredSchedule,
} from "@modules/scheduling/domain/schedule";
import type {
  ScheduledTaskAccessScope,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";

const weekdaySchema = Type.Union(SCHEDULE_WEEKDAYS.map((weekday) => Type.Literal(weekday)));

const watchPrioritySchema = Type.Union([Type.Literal("normal"), Type.Literal("urgent")]);

interface WatchUpdateDetails {
  readonly id: string;
  readonly updated: boolean;
  readonly enabled: boolean;
  readonly nextRunAt?: string;
}

interface WatchGetDetails {
  readonly id: string;
  readonly found: boolean;
  readonly priority?: "normal" | "urgent";
}

const recurringScheduleSchema = Type.Union([
  Type.Object({
    type: Type.Literal("daily"),
    time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
  }),
  Type.Object({
    type: Type.Literal("weekly"),
    time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
    weekdays: Type.Array(weekdaySchema, { minItems: 1, uniqueItems: true }),
  }),
  Type.Object({
    type: Type.Literal("every"),
    minutes: Type.Integer({ minimum: 1, maximum: MAX_SCHEDULE_INTERVAL_MINUTES }),
  }),
]);

export function createWatchTools(
  store: ScheduledTaskStore,
  channelId: string,
  accessScope: ScheduledTaskAccessScope,
  watchCheckRunner: WatchCheckRunner,
  ownerWorkerId?: string,
) {
  const canManage = (watch: WatchTask) =>
    ownerWorkerId === undefined || watch.ownerWorkerId === ownerWorkerId;
  return [
    defineTool({
      name: "watch_add",
      label: "Add Watch",
      description:
        "Run a JavaScript check on a recurring schedule. The script ends by calling `wake()` to notify the agent or `silent()` to do nothing; ending without either is an error. " +
        "script runs in a QuickJS sandbox: it reads the array `args`, calls the tools listed in the `watch` section (for example `tools.fetch_content({ url })`; that `fetch_content` is a read-only subset of the session tool), and prints with `text()` or `console.*`. " +
        "Only the tools in the `watch` section are available; normal session tools, timers, files, and process APIs are not. " +
        "`store(key, value)` and `load(key)` keep JSON values between checks of the same watch; storing `undefined` deletes a key. " +
        "Text printed with `text()` or `console.*` becomes the wake output. " +
        "The wake goes to the session that registered the watch: the conversation agent, or the worker that called this tool. " +
        'Set `priority` to "urgent" only for watches whose wake should reach the user immediately; it defaults to "normal". ' +
        "The script runs once before the watch is registered; if that run fails, the watch is not registered. " +
        "Times use Japan Standard Time (JST). Weekly schedules require one or more weekdays: sun, mon, tue, wed, thu, fri, sat.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 100 }),
        schedule: recurringScheduleSchema,
        script: Type.String({ minLength: 1, maxLength: 20_000 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
        priority: Type.Optional(watchPrioritySchema),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const now = Date.now();
        const resolved = resolveSchedule(params.schedule as ScheduleInput, now);
        const watch: WatchTask = {
          kind: "watch",
          id: randomUUID(),
          channelId,
          accessScope,
          createdAt: new Date(now).toISOString(),
          name: params.name.trim(),
          script: params.script.trim(),
          args: params.args ?? [],
          message: params.message.trim(),
          ...(params.priority !== undefined ? { priority: params.priority } : {}),
          ...(ownerWorkerId ? { ownerWorkerId } : {}),
          enabled: true,
          consecutiveFailures: 0,
          schedule: resolved.schedule,
          nextRunAt: resolved.nextRunAt,
        };
        if (!watch.name || !watch.script || !watch.message) {
          throw new Error("A watch needs a name, a script, and a message.");
        }
        await requireSuccessfulDryRun(
          watchCheckRunner,
          watch,
          "The watch was not registered because its script failed the dry run:",
        );
        await store.create(watch);
        return {
          content: [
            {
              type: "text",
              text: `watch を登録しました。ID: ${watch.id} / ${formatSchedule(watch.schedule)}`,
            },
          ],
          details: { id: watch.id, nextRunAt: watch.nextRunAt },
        };
      },
    }),
    defineTool({
      name: "watch_update",
      label: "Update Watch",
      description:
        "Update one watch in the current conversation by its ID. Use it to edit the name, schedule, script, args, or notification message, and to disable or re-enable the watch with `enabled`. " +
        'Set `priority` to "urgent" only for watches whose wake should reach the user immediately. Leaving it out keeps the current priority. ' +
        "Changing the schedule or enabling a disabled watch schedules the next check from now. " +
        "Enabling a disabled watch runs the script once first; if that run fails, the watch stays disabled. " +
        "Changing the script or enabling a disabled watch also clears the consecutive failure count and the last error, so the next failure is notified again. " +
        "Use watch_list to find the ID.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        schedule: Type.Optional(recurringScheduleSchema),
        script: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
        message: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
        enabled: Type.Optional(Type.Boolean()),
        priority: Type.Optional(watchPrioritySchema),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const watches = await store.listForScope("watch", channelId, accessScope);
        const current = watches.find((watch) => watch.id === params.id && canManage(watch));
        if (!current) {
          const details: WatchUpdateDetails = { id: params.id, updated: false, enabled: false };
          return {
            content: [
              {
                type: "text",
                text: `この会話にID ${params.id} の watch はありません。`,
              },
            ],
            details,
          };
        }

        const now = Date.now();
        const resolvedSchedule = params.schedule
          ? resolveSchedule(params.schedule as ScheduleInput, now)
          : undefined;
        const enabled = params.enabled ?? current.enabled;
        const script = params.script?.trim() ?? current.script;
        const resetsFailureState = script !== current.script || (enabled && !current.enabled);
        const nextRunAt = resolvedSchedule
          ? resolvedSchedule.nextRunAt
          : enabled && !current.enabled
            ? requireNextRunAt(current.schedule, now)
            : current.nextRunAt;
        const updated: WatchTask = {
          ...(resetsFailureState ? resetWatchFailureState(current) : current),
          name: params.name?.trim() ?? current.name,
          schedule: resolvedSchedule?.schedule ?? current.schedule,
          script,
          args: params.args ?? current.args,
          message: params.message?.trim() ?? current.message,
          ...(params.priority !== undefined ? { priority: params.priority } : {}),
          enabled,
          nextRunAt,
        };
        if (!updated.name || !updated.script || !updated.message) {
          throw new Error("A watch needs a name, a script, and a message.");
        }
        if (updated.enabled && !current.enabled) {
          await requireSuccessfulDryRun(
            watchCheckRunner,
            updated,
            "The watch was not enabled because its script failed the dry run:",
          );
        }
        await store.update(updated);
        const details: WatchUpdateDetails = {
          id: updated.id,
          updated: true,
          enabled: updated.enabled,
          nextRunAt: updated.nextRunAt,
        };
        return {
          content: [
            {
              type: "text",
              text: `watch を更新しました。\n${formatWatch(updated)}`,
            },
          ],
          details,
        };
      },
    }),
    defineTool({
      name: "watch_list",
      label: "List Watches",
      description:
        "List watches attached to the current conversation, or the watches owned by this worker session, including their next run and last status.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const watches = (await store.listForScope("watch", channelId, accessScope)).filter(
          (watch) => canManage(watch),
        );
        return {
          content: [
            {
              type: "text",
              text:
                watches.length === 0
                  ? "この会話に watch はありません。"
                  : watches.map((watch) => formatWatch(watch)).join("\n"),
            },
          ],
          details: {
            watches: watches.map((watch) => serializeWatchListItem(watch)),
          },
        };
      },
    }),
    defineTool({
      name: "watch_get",
      label: "Show Watch",
      description:
        "Show one watch in the current conversation by its ID, including its script, args, schedule, saved state, and notification message. Use watch_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const watches = await store.listForScope("watch", channelId, accessScope);
        const watch = watches.find(
          (candidate) => candidate.id === params.id && canManage(candidate),
        );
        if (!watch) {
          const details: WatchGetDetails = { id: params.id, found: false };
          return {
            content: [
              {
                type: "text",
                text: `この会話にID ${params.id} の watch はありません。`,
              },
            ],
            details,
          };
        }
        const details: WatchGetDetails = {
          id: watch.id,
          found: true,
          priority: watch.priority ?? "normal",
        };
        return {
          content: [{ type: "text", text: formatWatchDetails(watch) }],
          details,
        };
      },
    }),
    defineTool({
      name: "watch_delete",
      label: "Delete Watch",
      description:
        "Delete one watch in the current conversation by its ID. Use watch_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const watches = await store.listForScope("watch", channelId, accessScope);
        const watch = watches.find(
          (candidate) => candidate.id === params.id && canManage(candidate),
        );
        const deleted = watch
          ? await store.delete("watch", channelId, accessScope, params.id)
          : false;
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `watch ${params.id} を削除しました。`
                : `この会話にID ${params.id} の watch はありません。`,
            },
          ],
          details: { id: params.id, deleted },
        };
      },
    }),
  ] as const;
}

interface WatchListItem {
  readonly id: string;
  readonly name: string;
  readonly nextRunAt: string;
  readonly schedule: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly message: string;
  readonly priority: "normal" | "urgent";
  readonly enabled: boolean;
  readonly consecutiveFailures: number;
  ownerWorkerId?: string;
  lastCheckedAt?: string;
  lastTriggeredAt?: string;
  lastStatus?: WatchTask["lastStatus"];
  lastError?: string;
}

function serializeWatchListItem(watch: WatchTask): WatchListItem {
  const item: WatchListItem = {
    id: watch.id,
    name: watch.name,
    nextRunAt: watch.nextRunAt,
    schedule: formatSchedule(watch.schedule),
    script: watch.script,
    args: watch.args,
    message: watch.message,
    priority: watch.priority ?? "normal",
    enabled: watch.enabled,
    consecutiveFailures: watch.consecutiveFailures,
  };
  if (watch.ownerWorkerId) item.ownerWorkerId = watch.ownerWorkerId;
  if (watch.lastCheckedAt) item.lastCheckedAt = watch.lastCheckedAt;
  if (watch.lastTriggeredAt) item.lastTriggeredAt = watch.lastTriggeredAt;
  if (watch.lastStatus) item.lastStatus = watch.lastStatus;
  if (watch.lastError) item.lastError = watch.lastError;
  return item;
}

function formatWatch(watch: WatchTask): string {
  const status = watch.lastStatus ? ` / 前回: ${watch.lastStatus}` : "";
  const error = watch.lastError ? ` / エラー: ${watch.lastError}` : "";
  const owner = watch.ownerWorkerId ? ` / ワーカー: ${watch.ownerWorkerId}` : "";
  const lastTriggeredAt = watch.lastTriggeredAt
    ? ` / 最終通知: ${formatJapanDateTime(watch.lastTriggeredAt)}`
    : "";
  const nextRun = watch.enabled ? `次回: ${formatJapanDateTime(watch.nextRunAt)}` : "停止中";
  return `- ${watch.id}: ${watch.name} — ${formatSchedule(watch.schedule)} / ${nextRun}${owner}${status}${lastTriggeredAt}${error}`;
}

function formatWatchDetails(watch: WatchTask): string {
  const nextRun = watch.enabled ? `次回: ${formatJapanDateTime(watch.nextRunAt)}` : "次回: 停止中";
  const args = watch.args.length === 0 ? "なし" : JSON.stringify(watch.args);
  const state = watch.state === undefined ? "なし" : JSON.stringify(watch.state);
  return [
    `${watch.id}: ${watch.name}`,
    `スケジュール: ${formatSchedule(watch.schedule)}`,
    nextRun,
    ...(watch.ownerWorkerId ? [`登録元ワーカー: ${watch.ownerWorkerId}`] : []),
    `引数: ${args}`,
    `通知内容: ${watch.message}`,
    `保存値: ${state}`,
    "スクリプト:",
    "```js",
    watch.script,
    "```",
  ].join("\n");
}

function requireNextRunAt(schedule: StoredSchedule, now: number): string {
  const nextRunAt = getNextRunAt(schedule, now);
  if (!nextRunAt) throw new Error("Could not compute the next run time for the watch.");
  return nextRunAt;
}

function resetWatchFailureState(watch: WatchTask): WatchTask {
  const { lastStatus: _lastStatus, lastError: _lastError, ...rest } = watch;
  return { ...rest, consecutiveFailures: 0 };
}

async function requireSuccessfulDryRun(
  runner: WatchCheckRunner,
  watch: WatchTask,
  failureMessage: string,
): Promise<void> {
  try {
    await runner.run(watch);
  } catch (error) {
    throw new Error(`${failureMessage}${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
