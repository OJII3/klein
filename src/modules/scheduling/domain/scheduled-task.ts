import type { AccessScope } from "@shared/access";
import { isRecurringSchedule, parseStoredSchedule, type StoredSchedule } from "./schedule";

export type ScheduledTaskAccessScope = AccessScope;
export type WatchCondition = "change" | "output";
export type WatchRuntime = "command" | "javascript";
export type WatchStatus = "ok" | "error";

interface ScheduledTaskBase {
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: ScheduledTaskAccessScope;
  readonly createdAt: string;
  readonly schedule: StoredSchedule;
  readonly nextRunAt: string;
}

export interface ReminderTask extends ScheduledTaskBase {
  readonly kind: "reminder";
  readonly message: string;
}

interface WatchTaskBase extends ScheduledTaskBase {
  readonly kind: "watch";
  readonly name: string;
  readonly args: readonly string[];
  readonly condition: WatchCondition;
  readonly message: string;
  readonly cooldownMinutes: number;
  readonly lastCheckedAt?: string;
  readonly lastTriggeredAt?: string;
  readonly lastOutputHash?: string;
  readonly lastStatus?: WatchStatus;
  readonly lastError?: string;
  readonly consecutiveFailures: number;
}

export interface CommandWatchTask extends WatchTaskBase {
  readonly runtime: "command";
  readonly command: string;
}

export interface ScriptWatchTask extends WatchTaskBase {
  readonly runtime: "javascript";
  readonly script: string;
}

export type WatchTask = CommandWatchTask | ScriptWatchTask;

export type ScheduledTask = ReminderTask | WatchTask;

export function parseScheduledTask(value: unknown): ScheduledTask {
  if (
    typeof value !== "object" ||
    value === null ||
    "dueAt" in value ||
    "repeat" in value ||
    "sessionKey" in value ||
    "ownerFeaturesAllowed" in value
  ) {
    throw new Error(
      "スケジュールの保存形式が不正です。旧形式には対応していないため、migration script で移行してください。",
    );
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.channelId !== "string" ||
    record.channelId.length === 0 ||
    typeof record.accessScope !== "string" ||
    !/^(?:public|owner:\d+)$/u.test(record.accessScope) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.nextRunAt !== "string" ||
    !Number.isFinite(Date.parse(record.nextRunAt))
  ) {
    throw new Error("スケジュールの保存内容が不正です。");
  }

  const schedule = parseStoredSchedule(record.schedule);
  if (record.kind === "reminder") {
    if (typeof record.message !== "string" || record.message.length === 0) {
      throw new Error("リマインダーの本文が不正です。");
    }
    return {
      kind: "reminder",
      id: record.id,
      channelId: record.channelId,
      accessScope: record.accessScope as ScheduledTaskAccessScope,
      createdAt: record.createdAt,
      schedule,
      nextRunAt: record.nextRunAt,
      message: record.message,
    };
  }

  if (record.kind === "watch") {
    const runtime = record.runtime ?? "command";
    if (
      !record.accessScope.startsWith("owner:") ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      (runtime !== "command" && runtime !== "javascript") ||
      (record.command !== undefined && typeof record.command !== "string") ||
      (record.script !== undefined && typeof record.script !== "string") ||
      !Array.isArray(record.args) ||
      !record.args.every((arg) => typeof arg === "string") ||
      (record.condition !== "change" && record.condition !== "output") ||
      typeof record.message !== "string" ||
      record.message.length === 0 ||
      !Number.isInteger(record.cooldownMinutes) ||
      (record.cooldownMinutes as number) < 0 ||
      !isRecurringSchedule(schedule) ||
      (record.lastCheckedAt !== undefined &&
        (typeof record.lastCheckedAt !== "string" ||
          !Number.isFinite(Date.parse(record.lastCheckedAt)))) ||
      (record.lastTriggeredAt !== undefined &&
        (typeof record.lastTriggeredAt !== "string" ||
          !Number.isFinite(Date.parse(record.lastTriggeredAt)))) ||
      (record.lastOutputHash !== undefined && typeof record.lastOutputHash !== "string") ||
      (record.lastStatus !== undefined &&
        record.lastStatus !== "ok" &&
        record.lastStatus !== "error") ||
      (record.lastError !== undefined && typeof record.lastError !== "string") ||
      !Number.isInteger(record.consecutiveFailures) ||
      (record.consecutiveFailures as number) < 0
    ) {
      throw new Error("監視設定の保存内容が不正です。");
    }
    return buildWatchTask(record, runtime, schedule, {
      kind: "watch",
      id: record.id,
      channelId: record.channelId,
      accessScope: record.accessScope as ScheduledTaskAccessScope,
      createdAt: record.createdAt,
      nextRunAt: record.nextRunAt,
      name: record.name,
      args: record.args as string[],
      condition: record.condition,
      message: record.message,
      cooldownMinutes: record.cooldownMinutes as number,
      ...(record.lastCheckedAt !== undefined
        ? { lastCheckedAt: record.lastCheckedAt as string }
        : {}),
      ...(record.lastTriggeredAt !== undefined
        ? { lastTriggeredAt: record.lastTriggeredAt as string }
        : {}),
      ...(record.lastOutputHash !== undefined
        ? { lastOutputHash: record.lastOutputHash as string }
        : {}),
      ...(record.lastStatus !== undefined ? { lastStatus: record.lastStatus as WatchStatus } : {}),
      ...(record.lastError !== undefined ? { lastError: record.lastError as string } : {}),
      consecutiveFailures: record.consecutiveFailures as number,
    });
  }

  throw new Error("スケジュールの種類が不正です。");
}

function buildWatchTask(
  record: Record<string, unknown>,
  runtime: WatchRuntime,
  schedule: StoredSchedule,
  base: Omit<CommandWatchTask, "runtime" | "command" | "schedule"> &
    Omit<ScriptWatchTask, "runtime" | "script" | "schedule">,
): WatchTask {
  if (runtime === "command") {
    if (
      typeof record.command !== "string" ||
      record.command.length === 0 ||
      record.script !== undefined
    ) {
      throw new Error("監視設定の保存内容が不正です。");
    }
    return { ...base, schedule, runtime: "command", command: record.command };
  }
  if (
    typeof record.script !== "string" ||
    record.script.length === 0 ||
    record.command !== undefined
  ) {
    throw new Error("監視設定の保存内容が不正です。");
  }
  return { ...base, schedule, runtime: "javascript", script: record.script };
}
