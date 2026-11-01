import { ownerAccessScope, PUBLIC_ACCESS_SCOPE } from "@shared/access";
import type { ReminderTask } from "../domain/scheduled-task";
import { SCHEDULE_WEEKDAYS, type ScheduleWeekday, type StoredSchedule } from "../domain/schedule";

export interface LegacyReminderMigrationOptions {
  readonly ownerUserId?: string;
}

/**
 * Converts reminder files written before the unified schedule store existed.
 * This is intentionally not used by the application at runtime.
 */
export function migrateLegacyReminder(
  value: unknown,
  options: LegacyReminderMigrationOptions = {},
): ReminderTask {
  if (typeof value !== "object" || value === null) {
    throw new Error("リマインダーの保存内容が不正です。");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.channelId !== "string" ||
    record.channelId.length === 0 ||
    typeof record.message !== "string" ||
    record.message.length === 0 ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.dueAt !== "string" ||
    !Number.isFinite(Date.parse(record.dueAt))
  ) {
    throw new Error("リマインダーのID・チャンネル・本文・日時を確認してください。");
  }

  return {
    kind: "reminder",
    id: record.id,
    channelId: record.channelId,
    accessScope: resolveAccessScope(record, options.ownerUserId),
    createdAt: record.createdAt,
    message: record.message,
    schedule: resolveSchedule(record),
    nextRunAt: record.dueAt,
  };
}

function resolveAccessScope(
  record: Record<string, unknown>,
  ownerUserId: string | undefined,
): ReminderTask["accessScope"] {
  if (record.accessScope !== undefined) {
    if (
      typeof record.accessScope === "string" &&
      /^(?:public|owner:\d+)$/u.test(record.accessScope)
    ) {
      return record.accessScope as ReminderTask["accessScope"];
    }
    throw new Error("リマインダーの accessScope が不正です。");
  }
  if (record.ownerFeaturesAllowed === true) {
    if (!ownerUserId) {
      throw new Error(
        "owner 用リマインダーを移行するには config の owner.discord.userId が必要です。",
      );
    }
    return ownerAccessScope(ownerUserId);
  }
  return PUBLIC_ACCESS_SCOPE;
}

function resolveSchedule(record: Record<string, unknown>): StoredSchedule {
  if (record.repeat === undefined) {
    return { type: "once", at: record.dueAt as string };
  }
  if (typeof record.time !== "string") {
    throw new Error("繰り返しリマインダーには時刻が必要です。");
  }
  if (record.repeat === "daily") {
    return { type: "daily", time: record.time };
  }
  if (record.repeat === "weekly") {
    if (
      !Array.isArray(record.weekdays) ||
      record.weekdays.length === 0 ||
      !record.weekdays.every((weekday) => typeof weekday === "string" && isWeekday(weekday))
    ) {
      throw new Error("毎週のリマインダーには1つ以上の曜日が必要です。");
    }
    return {
      type: "weekly",
      time: record.time,
      weekdays: record.weekdays as ScheduleWeekday[],
    };
  }
  throw new Error(`未対応の繰り返し設定です: ${String(record.repeat)}`);
}

function isWeekday(value: string): value is ScheduleWeekday {
  return (SCHEDULE_WEEKDAYS as readonly string[]).includes(value);
}
