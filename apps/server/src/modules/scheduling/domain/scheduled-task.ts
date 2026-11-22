import { parseAccessScope, type AccessScope } from "@shared/access";
import { isRecord } from "@shared/type-guards";

import { isRecurringSchedule, parseStoredSchedule, type StoredSchedule } from "./schedule";

export type ScheduledTaskAccessScope = AccessScope;
export type WatchStatus = "ok" | "error";
export type WatchPriority = "normal" | "urgent";

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

export interface WatchTask extends ScheduledTaskBase {
  readonly kind: "watch";
  readonly name: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly message: string;
  /**
   * How urgently the wake should reach the conversation. Older saved watches
   * without this field are read as "normal".
   */
  readonly priority?: WatchPriority;
  /**
   * The worker that registered the watch. Its wake goes to that worker
   * session instead of the conversation session.
   */
  readonly ownerWorkerId?: string;
  readonly enabled: boolean;
  /** Values the script kept with `store()`. */
  readonly state?: Readonly<Record<string, unknown>>;
  readonly lastCheckedAt?: string;
  readonly lastTriggeredAt?: string;
  readonly lastStatus?: WatchStatus;
  readonly lastError?: string;
  readonly consecutiveFailures: number;
}

export type ScheduledTask = ReminderTask | WatchTask;

export function parseScheduledTask(value: unknown): ScheduledTask {
  if (
    !isRecord(value) ||
    "dueAt" in value ||
    "repeat" in value ||
    "sessionKey" in value ||
    "ownerFeaturesAllowed" in value
  ) {
    throw new Error("スケジュールの保存形式が不正です。旧形式には対応していません。");
  }

  const { id, channelId, createdAt, nextRunAt, kind } = value;
  const accessScope = parseAccessScope(value.accessScope);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    accessScope === undefined ||
    (accessScope !== "public" && !/^(?:owner|user):\d+$/u.test(accessScope)) ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof nextRunAt !== "string" ||
    !Number.isFinite(Date.parse(nextRunAt))
  ) {
    throw new Error("スケジュールの保存内容が不正です。");
  }

  const schedule = parseStoredSchedule(value.schedule);
  if (kind === "reminder") {
    const { message } = value;
    if (typeof message !== "string" || message.length === 0) {
      throw new Error("リマインダーの本文が不正です。");
    }
    return {
      kind: "reminder",
      id,
      channelId,
      accessScope,
      createdAt,
      schedule,
      nextRunAt,
      message,
    };
  }

  if (kind === "watch") {
    const {
      name,
      script,
      args,
      message,
      priority,
      ownerWorkerId: storedOwnerWorkerId,
      ownerTaskId: legacyOwnerWorkerId,
      enabled,
      state,
      lastCheckedAt,
      lastTriggeredAt,
      lastStatus,
      lastError,
      consecutiveFailures,
    } = value;
    const ownerWorkerId = storedOwnerWorkerId ?? legacyOwnerWorkerId;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      typeof script !== "string" ||
      script.length === 0 ||
      !isStringArray(args) ||
      typeof message !== "string" ||
      message.length === 0 ||
      (priority !== undefined && priority !== "normal" && priority !== "urgent") ||
      (ownerWorkerId !== undefined &&
        (typeof ownerWorkerId !== "string" || ownerWorkerId.length === 0)) ||
      (enabled !== undefined && typeof enabled !== "boolean") ||
      (state !== undefined && !isRecord(state)) ||
      !isRecurringSchedule(schedule) ||
      (lastCheckedAt !== undefined &&
        (typeof lastCheckedAt !== "string" || !Number.isFinite(Date.parse(lastCheckedAt)))) ||
      (lastTriggeredAt !== undefined &&
        (typeof lastTriggeredAt !== "string" || !Number.isFinite(Date.parse(lastTriggeredAt)))) ||
      (lastStatus !== undefined && lastStatus !== "ok" && lastStatus !== "error") ||
      (lastError !== undefined && typeof lastError !== "string") ||
      typeof consecutiveFailures !== "number" ||
      !Number.isInteger(consecutiveFailures) ||
      consecutiveFailures < 0
    ) {
      throw new Error("watch 設定の保存内容が不正です。");
    }
    return {
      kind: "watch",
      id,
      channelId,
      accessScope,
      createdAt,
      schedule,
      nextRunAt,
      name,
      script,
      args,
      message,
      priority: priority ?? "normal",
      ...(ownerWorkerId !== undefined ? { ownerWorkerId } : {}),
      enabled: enabled !== false,
      ...(state !== undefined ? { state } : {}),
      ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      ...(lastTriggeredAt !== undefined ? { lastTriggeredAt } : {}),
      ...(lastStatus !== undefined ? { lastStatus } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      consecutiveFailures,
    };
  }

  throw new Error("スケジュールの種類が不正です。");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}
