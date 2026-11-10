import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  formatJapanDateTime,
  formatSchedule,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  resolveSchedule,
  SCHEDULE_WEEKDAYS,
  type ScheduleInput,
} from "@modules/scheduling/domain/schedule";
import type {
  ScheduledTaskAccessScope,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";

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
    minutes: Type.Integer({ minimum: 1, maximum: MAX_SCHEDULE_INTERVAL_MINUTES }),
  }),
]);

export function createWatchTools(
  store: ScheduledTaskStore,
  channelId: string,
  accessScope: ScheduledTaskAccessScope,
) {
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
        "Times use Japan Standard Time (JST). Weekly schedules require one or more weekdays: sun, mon, tue, wed, thu, fri, sat.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 100 }),
        schedule: recurringScheduleSchema,
        script: Type.String({ minLength: 1, maxLength: 20_000 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
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
          consecutiveFailures: 0,
          schedule: resolved.schedule,
          nextRunAt: resolved.nextRunAt,
        };
        if (!watch.name || !watch.script || !watch.message) {
          throw new Error("監視名・スクリプト・通知内容を入力してください。");
        }
        await store.create(watch);
        return {
          content: [
            {
              type: "text",
              text: `監視を登録しました。ID: ${watch.id} / ${formatSchedule(watch.schedule)}`,
            },
          ],
          details: { id: watch.id, nextRunAt: watch.nextRunAt },
        };
      },
    }),
    defineTool({
      name: "watch_list",
      label: "List Watches",
      description:
        "List watches attached to the current conversation, including their next run and last status.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const watches = await store.listForScope("watch", channelId, accessScope);
        return {
          content: [
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
                schedule,
                script,
                args,
                message,
                lastCheckedAt,
                lastTriggeredAt,
                lastStatus,
                lastError,
                consecutiveFailures,
              }) => ({
                id,
                name,
                nextRunAt,
                schedule: formatSchedule(schedule),
                script,
                args,
                message,
                consecutiveFailures,
                ...(lastCheckedAt ? { lastCheckedAt } : {}),
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
      label: "Delete Watch",
      description:
        "Delete one watch in the current conversation by its ID. Use watch_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const deleted = await store.delete("watch", channelId, accessScope, params.id);
        return {
          content: [
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

function formatWatch(watch: WatchTask): string {
  const status = watch.lastStatus ? ` / 前回: ${watch.lastStatus}` : "";
  const error = watch.lastError ? ` / エラー: ${watch.lastError}` : "";
  const lastTriggeredAt = watch.lastTriggeredAt
    ? ` / 最終通知: ${formatJapanDateTime(watch.lastTriggeredAt)}`
    : "";
  return `- ${watch.id}: ${watch.name} — ${formatSchedule(watch.schedule)} / 次回: ${formatJapanDateTime(watch.nextRunAt)}${status}${lastTriggeredAt}${error}`;
}
