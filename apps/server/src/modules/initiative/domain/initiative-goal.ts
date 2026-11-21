import { parseAccessScope, type AccessScope } from "@shared/access";
import { isRecord } from "@shared/type-guards";

export type InitiativeGoalStatus =
  "scheduled" | "running" | "ready" | "delivered" | "dismissed" | "expired" | "failed";

export type InitiativeGoalRisk = "low" | "medium" | "high";

export type InitiativeGoalDelivery = "interrupt" | "attach" | "digest" | "silent";

export type InitiativeGoalSourceKind = "conversation" | "memory" | "self";

export interface InitiativeGoalSource {
  readonly kind: InitiativeGoalSourceKind;
  readonly messageIds?: readonly string[];
}

export interface InitiativeGoal {
  readonly version: 1;
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly title: string;
  readonly rationale: string;
  readonly source: InitiativeGoalSource;
  readonly plan: string;
  readonly dueAt: string;
  readonly expiresAt: string;
  readonly risk: InitiativeGoalRisk;
  readonly delivery?: InitiativeGoalDelivery;
  readonly status: InitiativeGoalStatus;
  readonly dedupeKey: string;
  readonly createdBy: "planner" | "conversation";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workerId?: string;
  readonly signalId?: string;
  readonly lastError?: string;
}

export interface InitiativeGoalProposal {
  readonly title: string;
  readonly rationale: string;
  readonly plan: string;
  readonly dueAt: string;
  readonly expiresAt?: string;
  readonly risk: InitiativeGoalRisk;
  readonly delivery?: InitiativeGoalDelivery;
  readonly sourceMessageIds?: readonly string[];
}

const GOAL_STATUSES: readonly InitiativeGoalStatus[] = [
  "scheduled",
  "running",
  "ready",
  "delivered",
  "dismissed",
  "expired",
  "failed",
];

const GOAL_RISKS: readonly InitiativeGoalRisk[] = ["low", "medium", "high"];

const GOAL_DELIVERY_MODES: readonly InitiativeGoalDelivery[] = [
  "interrupt",
  "attach",
  "digest",
  "silent",
];

const GOAL_SOURCE_KINDS: readonly InitiativeGoalSourceKind[] = ["conversation", "memory", "self"];

const TITLE_MAX_LENGTH = 200;
const RATIONALE_MAX_LENGTH = 2_000;
const PLAN_MAX_LENGTH = 8_000;
const DEDUPE_KEY_MAX_LENGTH = 2_000;

export function parseInitiativeGoal(value: unknown): InitiativeGoal {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Goal の保存形式が不正です。");
  }

  const {
    id,
    channelId,
    title,
    rationale,
    source,
    plan,
    dueAt,
    expiresAt,
    risk,
    delivery,
    status,
    dedupeKey,
    createdBy,
    createdAt,
    updatedAt,
  } = value;
  const accessScope = parseAccessScope(value.accessScope);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof channelId !== "string" ||
    channelId.length === 0 ||
    accessScope === undefined ||
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > TITLE_MAX_LENGTH ||
    typeof rationale !== "string" ||
    rationale.length === 0 ||
    rationale.length > RATIONALE_MAX_LENGTH ||
    typeof plan !== "string" ||
    plan.length === 0 ||
    plan.length > PLAN_MAX_LENGTH ||
    !isTimestamp(dueAt) ||
    !isTimestamp(expiresAt) ||
    Date.parse(expiresAt) < Date.parse(dueAt) ||
    !isGoalRisk(risk) ||
    !isGoalStatus(status) ||
    typeof dedupeKey !== "string" ||
    dedupeKey.length === 0 ||
    dedupeKey.length > DEDUPE_KEY_MAX_LENGTH ||
    (createdBy !== "planner" && createdBy !== "conversation") ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt)
  ) {
    throw new Error("Goal の保存内容が不正です。");
  }

  return {
    version: 1,
    id,
    channelId,
    accessScope,
    title,
    rationale,
    source: parseSource(source),
    plan,
    dueAt,
    expiresAt,
    risk,
    ...(delivery !== undefined ? { delivery: parseDelivery(delivery) } : {}),
    status,
    dedupeKey,
    createdBy,
    createdAt,
    updatedAt,
    ...optionalText(value, "workerId"),
    ...optionalText(value, "signalId"),
    ...optionalText(value, "lastError"),
  };
}

export function isActiveGoal(goal: InitiativeGoal): boolean {
  return goal.status === "scheduled" || goal.status === "running" || goal.status === "ready";
}

export function isGoalDue(goal: InitiativeGoal, now: number): boolean {
  return goal.status === "scheduled" && Date.parse(goal.dueAt) <= now;
}

export function isGoalExpired(goal: InitiativeGoal, now: number): boolean {
  return Date.parse(goal.expiresAt) <= now;
}

export function markGoalRunning(goal: InitiativeGoal, now: number): InitiativeGoal {
  return transition(goal, "running", now);
}

export function markGoalReady(goal: InitiativeGoal, signalId: string, now: number): InitiativeGoal {
  return { ...transition(goal, "ready", now), signalId };
}

export function markGoalDelivered(goal: InitiativeGoal, now: number): InitiativeGoal {
  return transition(goal, "delivered", now);
}

export function markGoalDismissed(goal: InitiativeGoal, now: number): InitiativeGoal {
  return transition(goal, "dismissed", now);
}

export function markGoalExpired(goal: InitiativeGoal, now: number): InitiativeGoal {
  return transition(goal, "expired", now);
}

export function markGoalFailed(goal: InitiativeGoal, error: string, now: number): InitiativeGoal {
  return { ...transition(goal, "failed", now), lastError: error };
}

export function createGoalDedupeKey(input: {
  readonly title: string;
  readonly sourceMessageIds?: readonly string[];
  readonly dueAt: string;
}): string {
  return JSON.stringify([
    normalizeInlineText(input.title).toLowerCase(),
    ...(input.sourceMessageIds ?? []).map((id) => normalizeInlineText(id)).toSorted(),
    input.dueAt.slice(0, 10),
  ]);
}

export function formatGoal(goal: InitiativeGoal): string {
  return `${normalizeInlineText(goal.title)}（${goal.status} / ${formatJapanTimestamp(goal.dueAt)}）`;
}

function transition(
  goal: InitiativeGoal,
  status: InitiativeGoalStatus,
  now: number,
): InitiativeGoal {
  return { ...goal, status, updatedAt: new Date(now).toISOString() };
}

function parseSource(value: unknown): InitiativeGoalSource {
  if (!isRecord(value) || !isGoalSourceKind(value.kind)) {
    throw new Error("Goal の根拠が不正です。");
  }
  const { messageIds } = value;
  if (messageIds === undefined) return { kind: value.kind };
  if (!Array.isArray(messageIds)) {
    throw new TypeError("Goal の根拠メッセージが不正です。");
  }
  const ids: string[] = [];
  for (const item of messageIds) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("Goal の根拠メッセージが不正です。");
    }
    ids.push(item);
  }
  return { kind: value.kind, messageIds: ids };
}

function parseDelivery(value: unknown): InitiativeGoalDelivery {
  if (!isGoalDelivery(value)) throw new Error("Goal の配信方法が不正です。");
  return value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isGoalStatus(value: unknown): value is InitiativeGoalStatus {
  return GOAL_STATUSES.some((candidate) => candidate === value);
}

function isGoalRisk(value: unknown): value is InitiativeGoalRisk {
  return GOAL_RISKS.some((candidate) => candidate === value);
}

function isGoalDelivery(value: unknown): value is InitiativeGoalDelivery {
  return GOAL_DELIVERY_MODES.some((candidate) => candidate === value);
}

function isGoalSourceKind(value: unknown): value is InitiativeGoalSourceKind {
  return GOAL_SOURCE_KINDS.some((candidate) => candidate === value);
}

function optionalText(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`Goal の${key}が不正です。`);
  }
  return { [key]: entry };
}

function normalizeInlineText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function formatJapanTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}
