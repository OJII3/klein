import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import {
  formatJapanDateTime,
  formatSchedule,
  resolveSchedule,
  SCHEDULE_WEEKDAYS,
  type ScheduleInput,
} from "@modules/scheduling/domain/schedule";
import type {
  CommandWatchTask,
  WatchRuntime,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { ownerAccessScope } from "@shared/access";

const weekdaySchema = Type.Union(SCHEDULE_WEEKDAYS.map((weekday) => Type.Literal(weekday)));
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
    minutes: Type.Integer({ minimum: 1 }),
  }),
]);
const conditionSchema = Type.Union([Type.Literal("change"), Type.Literal("output")]);
const runtimeSchema = Type.Union([Type.Literal("command"), Type.Literal("javascript")]);

export function createWatchTools(
  store: ScheduledTaskStore,
  channelId: string,
  ownerUserId: string,
) {
  const accessScope = ownerAccessScope(ownerUserId);
  return [
    defineTool({
      name: "watch_add",
      description:
        "Run a check on a recurring schedule and send an event only when its output changes (condition='change') or is non-empty (condition='output'). " +
        "With condition='change', the first successful check only stores a baseline. " +
        "Use runtime='command' (default) with command as an executable path, not a shell command line; no shell is used, so pass an explicit interpreter and script through command/args when needed. " +
        "Use runtime='javascript' with script as JavaScript source instead. Scripts run in a QuickJS sandbox: they read the array `args`, call `fetch(url, init)` for HTTP requests, and print with `text()` or `console.*`. " +
        "The text output plus the returned value become the watch output; there are no timers, files, or process APIs. " +
        "Times use Japan Standard Time (JST). Weekly schedules require one or more weekdays: sun, mon, tue, wed, thu, fri, sat.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 100 }),
        schedule: recurringScheduleSchema,
        runtime: Type.Optional(runtimeSchema),
        command: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
        script: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
        condition: Type.Optional(conditionSchema),
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
        cooldownMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_080 })),
      }),
      deferred: true,
      async execute(params) {
        const now = Date.now();
        const resolved = resolveSchedule(params.schedule as ScheduleInput, now);
        const base = {
          kind: "watch" as const,
          id: randomUUID(),
          channelId,
          accessScope,
          createdAt: new Date(now).toISOString(),
          name: params.name.trim(),
          args: params.args ?? [],
          condition: (params.condition ?? "change") as WatchTask["condition"],
          message: params.message.trim(),
          cooldownMinutes: params.cooldownMinutes ?? 0,
          consecutiveFailures: 0,
          schedule: resolved.schedule,
          nextRunAt: resolved.nextRunAt,
        };
        const watch = buildWatch(params.runtime ?? "command", base, params);
        if (!watch.name || !watch.message) {
          throw new Error("監視名・通知内容を入力してください。");
        }
        await store.create(watch);
        return {
          output: [
            {
              type: "text",
              text: `監視を登録しました。ID: ${watch.id} / ${formatSchedule(watch.schedule)} / ${watch.condition === "change" ? "出力変化時" : "出力あり"}に通知`,
            },
          ],
          details: { id: watch.id, nextRunAt: watch.nextRunAt },
        };
      },
    }),
    defineTool({
      name: "watch_list",
      description:
        "List watches attached to the current conversation, including their next run and last status.",
      parameters: Type.Object({}),
      deferred: true,
      replay: "safe",
      async execute() {
        const watches = await store.listForScope("watch", channelId, accessScope);
        return {
          output: [
            {
              type: "text",
              text:
                watches.length === 0
                  ? "この会話に監視はありません。"
                  : watches.map(formatWatch).join("\n"),
            },
          ],
          details: {
            watches: watches.map(
              ({
                id,
                name,
                nextRunAt,
                condition,
                schedule,
                lastTriggeredAt,
                lastStatus,
                lastError,
              }) => ({
                id,
                name,
                nextRunAt,
                condition,
                schedule: formatSchedule(schedule),
                ...(lastTriggeredAt ? { lastTriggeredAt } : {}),
                ...(lastStatus ? { lastStatus } : {}),
                ...(lastError ? { lastError } : {}),
              }),
            ),
          },
        };
      },
    }),
    defineTool({
      name: "watch_delete",
      description:
        "Delete one watch in the current conversation by its ID. Use watch_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      deferred: true,
      async execute(params) {
        const deleted = await store.delete("watch", channelId, accessScope, params.id);
        return {
          output: [
            {
              type: "text",
              text: deleted
                ? `監視 ${params.id} を削除しました。`
                : `この会話にID ${params.id} の監視はありません。`,
            },
          ],
          details: { id: params.id, deleted },
        };
      },
    }),
  ];
}

function buildWatch(
  runtime: WatchRuntime,
  base: Omit<CommandWatchTask, "runtime" | "command">,
  params: { readonly command?: string; readonly script?: string },
): WatchTask {
  if (runtime === "javascript") {
    const script = params.script?.trim();
    if (!script) {
      throw new Error("runtime='javascript' では script を指定してください。");
    }
    if (params.command !== undefined) {
      throw new Error("runtime='javascript' では command を指定できません。");
    }
    return { ...base, runtime: "javascript", script };
  }
  const command = params.command?.trim();
  if (!command) {
    throw new Error("runtime='command' では command を指定してください。");
  }
  if (params.script !== undefined) {
    throw new Error("runtime='command' では script を指定できません。");
  }
  return { ...base, runtime: "command", command };
}

function formatWatch(watch: WatchTask): string {
  const status = watch.lastStatus ? ` / 前回: ${watch.lastStatus}` : "";
  const error = watch.lastError ? ` / エラー: ${watch.lastError}` : "";
  const lastTriggeredAt = watch.lastTriggeredAt
    ? ` / 最終通知: ${formatJapanDateTime(watch.lastTriggeredAt)}`
    : "";
  return `- ${watch.id}: ${watch.name} — ${formatSchedule(watch.schedule)} / 次回: ${formatJapanDateTime(watch.nextRunAt)}${status}${lastTriggeredAt}${error}`;
}
