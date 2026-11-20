import { parseAccessScope, type AccessScope } from "@shared/access";
import { isRecord } from "@shared/type-guards";

export type FollowUpStatus = "active" | "notified" | "done" | "orphaned" | "expired" | "dismissed";

export type FollowUpWatcher = { kind: "watch" | "reminder" | "worker"; id: string };

export interface FollowUp {
  readonly version: 1;
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly subject: string;
  readonly watcher: FollowUpWatcher;
  readonly cadenceLabel: string;
  readonly status: FollowUpStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly lastNotifiedAt?: string;
  readonly originMessageId?: string;
}

const FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = [
  "active",
  "notified",
  "done",
  "orphaned",
  "expired",
  "dismissed",
];

const WATCHER_KINDS: readonly FollowUpWatcher["kind"][] = ["watch", "reminder", "worker"];

const STATUS_LABELS: Readonly<Record<FollowUpStatus, string>> = {
  active: "追跡中",
  notified: "通知済み",
  done: "完了",
  orphaned: "監視なし",
  expired: "期限切れ",
  dismissed: "取り下げ",
};

export function parseFollowUp(value: unknown): FollowUp {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError("約束の保存形式が不正です。");
  }

  const { id, channelId, subject, cadenceLabel, createdAt, updatedAt, status, watcher } = value;
  const accessScope = parseAccessScope(value.accessScope);
  if (!isRecord(watcher)) {
    throw new Error("約束の保存内容が不正です。");
  }
  // Follow-ups written before the rename stored workers as "task".
  const watcherKind = watcher.kind === "task" ? "worker" : watcher.kind;
  const watcherId = watcher.id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    accessScope === undefined ||
    (accessScope !== "public" && !/^(?:owner|user):\d+$/u.test(accessScope)) ||
    typeof subject !== "string" ||
    subject.length === 0 ||
    typeof cadenceLabel !== "string" ||
    cadenceLabel.length === 0 ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt) ||
    !isFollowUpStatus(status) ||
    !isWatcherKind(watcherKind) ||
    typeof watcherId !== "string" ||
    watcherId.length === 0
  ) {
    throw new Error("約束の保存内容が不正です。");
  }

  return {
    version: 1,
    id,
    channelId,
    accessScope,
    subject,
    watcher: { kind: watcherKind, id: watcherId },
    cadenceLabel,
    status,
    createdAt,
    updatedAt,
    ...optionalTimestamp(value, "expiresAt"),
    ...optionalTimestamp(value, "lastNotifiedAt"),
    ...optionalText(value, "originMessageId"),
  };
}

export function markFollowUpNotified(followUp: FollowUp, now: number): FollowUp {
  const updatedAt = new Date(now).toISOString();
  return { ...followUp, status: "notified", updatedAt, lastNotifiedAt: updatedAt };
}

export function markFollowUpDone(followUp: FollowUp, now: number): FollowUp {
  return transition(followUp, "done", now);
}

export function markFollowUpOrphaned(followUp: FollowUp, now: number): FollowUp {
  return transition(followUp, "orphaned", now);
}

export function markFollowUpExpired(followUp: FollowUp, now: number): FollowUp {
  return transition(followUp, "expired", now);
}

export function isFollowUpExpired(followUp: FollowUp, now: number): boolean {
  return followUp.expiresAt !== undefined && Date.parse(followUp.expiresAt) <= now;
}

export function formatFollowUp(followUp: FollowUp): string {
  return `${normalizeInlineText(followUp.subject)}（${normalizeInlineText(
    followUp.cadenceLabel,
  )} / ${STATUS_LABELS[followUp.status]}）`;
}

function transition(followUp: FollowUp, status: FollowUpStatus, now: number): FollowUp {
  return { ...followUp, status, updatedAt: new Date(now).toISOString() };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFollowUpStatus(value: unknown): value is FollowUpStatus {
  return FOLLOW_UP_STATUSES.some((candidate) => candidate === value);
}

function isWatcherKind(value: unknown): value is FollowUpWatcher["kind"] {
  return WATCHER_KINDS.some((candidate) => candidate === value);
}

function optionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (!isTimestamp(entry)) throw new Error(`約束の${key}が不正です。`);
  return { [key]: entry };
}

function optionalText(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`約束の${key}が不正です。`);
  }
  return { [key]: entry };
}

function normalizeInlineText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}
