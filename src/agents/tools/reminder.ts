import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import {
  formatSchedule,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  resolveSchedule,
  SCHEDULE_WEEKDAYS,
  type ScheduleInput,
} from "@modules/scheduling/domain/schedule";
import type {
  ReminderTask,
  ScheduledTaskAccessScope,
} from "@modules/scheduling/domain/scheduled-task";

const weekdaySchema = Type.Union(SCHEDULE_WEEKDAYS.map((weekday) => Type.Literal(weekday)));
const scheduleSchema = Type.Union([
  Type.Object({
    type: Type.Literal("after"),
    minutes: Type.Integer({ minimum: 1, maximum: MAX_SCHEDULE_INTERVAL_MINUTES }),
  }),
  Type.Object({
    type: Type.Literal("at"),
    date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    time: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
  }),
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

export function createReminderTools(
  store: ScheduledTaskStore,
  channelId: string,
  accessScope: ScheduledTaskAccessScope,
) {
  return [
    defineTool({
      name: "reminder_add",
      label: "Add Reminder",
      description:
        "Add a one-time reminder after a duration or at a date and time, or a repeating reminder every N minutes, daily, or weekly. " +
        "Times use Japan Standard Time (JST). Weekly reminders require one or more weekdays: sun, mon, tue, wed, thu, fri, sat.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
        schedule: scheduleSchema,
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const scheduleInput = params.schedule as ScheduleInput;
        const now = Date.now();
        const resolved = resolveSchedule(scheduleInput, now);
        const reminder: ReminderTask = {
          kind: "reminder",
          id: randomUUID(),
          channelId,
          accessScope,
          message: params.message.trim(),
          createdAt: new Date(now).toISOString(),
          schedule: resolved.schedule,
          nextRunAt: resolved.nextRunAt,
        };
        if (!reminder.message) throw new Error("リマインダーの内容を入力してください。");
        await store.create(reminder);
        return {
          content: [
            {
              type: "text",
              text: `リマインダーを登録しました。ID: ${reminder.id} / ${formatSchedule(reminder.schedule)}`,
            },
          ],
          details: { id: reminder.id, nextRunAt: reminder.nextRunAt },
        };
      },
    }),
    defineTool({
      name: "reminder_list",
      label: "List Reminders",
      description:
        "List reminders attached to the current conversation, including repeating reminders.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const reminders = await store.listForScope("reminder", channelId, accessScope);
        return {
          content: [
            {
              type: "text",
              text:
                reminders.length === 0
                  ? "この会話にリマインダーはありません。"
                  : reminders.map(formatReminder).join("\n"),
            },
          ],
          details: {
            reminders: reminders.map(({ id, nextRunAt, message, schedule }) => ({
              id,
              nextRunAt,
              message,
              schedule: formatSchedule(schedule),
            })),
          },
        };
      },
    }),
    defineTool({
      name: "reminder_delete",
      label: "Delete Reminder",
      description:
        "Delete one reminder in the current conversation by its ID. Use reminder_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const deleted = await store.delete("reminder", channelId, accessScope, params.id);
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `リマインダー ${params.id} を削除しました。`
                : `この会話にID ${params.id} のリマインダーはありません。`,
            },
          ],
          details: { id: params.id, deleted },
        };
      },
    }),
  ];
}

function formatReminder(reminder: ReminderTask): string {
  return `- ${reminder.id}: ${formatSchedule(reminder.schedule)} — ${reminder.message}`;
}
