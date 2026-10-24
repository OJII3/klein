import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import {
  formatReminderDateTime,
  getReminderDueAt,
  REMINDER_WEEKDAYS,
  type Reminder,
  type ReminderSchedule,
  type ReminderAccessScope,
} from "@modules/reminders/domain/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";

const weekdaySchema = Type.Union(REMINDER_WEEKDAYS.map((weekday) => Type.Literal(weekday)));
const scheduleSchema = Type.Union([
  Type.Object({
    type: Type.Literal("after"),
    minutes: Type.Integer({ minimum: 1 }),
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
]);

export function createReminderTools(
  store: ReminderStore,
  channelId: string,
  accessScope: ReminderAccessScope,
) {
  return [
    defineTool({
      name: "reminder_add",
      description:
        "Add a one-time reminder after a duration or at a date and time, or a daily/weekly reminder. " +
        "Times use Japan Standard Time (JST). Weekly reminders require one or more weekdays: sun, mon, tue, wed, thu, fri, sat.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
        schedule: scheduleSchema,
      }),
      deferred: true,
      async execute(params) {
        const schedule = params.schedule as ReminderSchedule;
        const now = Date.now();
        const reminder: Reminder = {
          id: randomUUID(),
          channelId,
          accessScope,
          message: params.message.trim(),
          createdAt: new Date(now).toISOString(),
          dueAt: getReminderDueAt(schedule, now),
          ...(schedule.type === "daily"
            ? { repeat: "daily" as const, time: schedule.time }
            : schedule.type === "weekly"
              ? {
                  repeat: "weekly" as const,
                  time: schedule.time,
                  weekdays: schedule.weekdays,
                }
              : {}),
        };
        if (!reminder.message) throw new Error("リマインダーの内容を入力してください。");
        await store.create(reminder);
        return {
          output: [
            {
              type: "text",
              text: `リマインダーを登録しました。ID: ${reminder.id} / ${formatReminderDateTime(reminder.dueAt)} JST`,
            },
          ],
          details: { id: reminder.id, dueAt: reminder.dueAt },
        };
      },
    }),
    defineTool({
      name: "reminder_list",
      description:
        "List reminders attached to the current conversation, including recurring reminders.",
      parameters: Type.Object({}),
      deferred: true,
      replay: "safe",
      async execute() {
        const reminders = await store.listForScope(channelId, accessScope);
        return {
          output: [
            {
              type: "text",
              text:
                reminders.length === 0
                  ? "この会話にリマインダーはありません。"
                  : reminders.map(formatReminder).join("\n"),
            },
          ],
          details: {
            reminders: reminders.map(({ id, dueAt, message, repeat, time, weekdays }) => ({
              id,
              dueAt,
              message,
              ...(repeat ? { repeat } : {}),
              ...(time ? { time } : {}),
              ...(weekdays ? { weekdays: [...weekdays] } : {}),
            })),
          },
        };
      },
    }),
    defineTool({
      name: "reminder_delete",
      description:
        "Delete one reminder in the current conversation by its ID. Use reminder_list to find the ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      deferred: true,
      async execute(params) {
        const deleted = await store.delete(channelId, accessScope, params.id);
        return {
          output: [
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

function formatReminder(reminder: Reminder): string {
  const repeat =
    reminder.repeat === "daily"
      ? `毎日 ${reminder.time}`
      : reminder.repeat === "weekly"
        ? `毎週 ${(reminder.weekdays ?? []).join(",")} ${reminder.time}`
        : formatReminderDateTime(reminder.dueAt);
  return `- ${reminder.id}: ${repeat} JST — ${reminder.message}`;
}
