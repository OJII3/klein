import { japanDateKey } from "@modules/proactivity/domain/japan-time";
import type { ProactivePreferences } from "@modules/proactivity/domain/proactive-preference";

import {
  createGoalDedupeKey,
  isActiveGoal,
  type InitiativeGoal,
  type InitiativeGoalProposal,
} from "./initiative-goal";

export type GoalApprovalMode = "auto" | "propose" | "off";

export interface InitiativeGoalPolicyOptions {
  readonly maxActiveGoals: number;
  readonly maxGoalsPerDay: number;
  readonly approval: GoalApprovalMode;
}

export interface InitiativeGoalPolicyInput {
  readonly proposal: InitiativeGoalProposal;
  readonly existingGoals: readonly InitiativeGoal[];
  readonly preferences: ProactivePreferences;
  readonly now: number;
}

export type InitiativeGoalPolicyDecision =
  | {
      readonly action: "accept";
      readonly dueAt: string;
      readonly expiresAt: string;
      readonly dedupeKey: string;
    }
  | { readonly action: "reject"; readonly reason: string };

const MIN_DUE_DELAY_MS = 5 * 60 * 1_000;
const MAX_DUE_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_GOAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_GOAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TITLE_LENGTH = 200;
const MAX_RATIONALE_LENGTH = 2_000;
const MAX_PLAN_LENGTH = 8_000;
const MAX_SOURCE_MESSAGE_IDS = 20;

export function decideGoalProposal(
  input: InitiativeGoalPolicyInput,
  options: InitiativeGoalPolicyOptions,
): InitiativeGoalPolicyDecision {
  const { proposal, now } = input;
  if (options.approval === "off") return reject("goal creation is off");
  if (proposal.risk !== "low") return reject(`risk ${proposal.risk} is not allowed`);
  if (proposal.title.trim().length === 0 || proposal.title.length > MAX_TITLE_LENGTH) {
    return reject("title is empty or too long");
  }
  if (proposal.rationale.trim().length === 0 || proposal.rationale.length > MAX_RATIONALE_LENGTH) {
    return reject("rationale is empty or too long");
  }
  if (proposal.plan.trim().length === 0 || proposal.plan.length > MAX_PLAN_LENGTH) {
    return reject("plan is empty or too long");
  }
  const sourceMessageIds = proposal.sourceMessageIds ?? [];
  if (
    sourceMessageIds.length > MAX_SOURCE_MESSAGE_IDS ||
    sourceMessageIds.some((id) => id.trim().length === 0)
  ) {
    return reject("source message ids are invalid");
  }

  const dueAt = Date.parse(proposal.dueAt);
  if (!Number.isFinite(dueAt)) return reject("dueAt is not a valid timestamp");
  if (dueAt < now + MIN_DUE_DELAY_MS) return reject("dueAt is too soon");
  if (dueAt > now + MAX_DUE_HORIZON_MS) return reject("dueAt is too far in the future");

  const expiresAt =
    proposal.expiresAt === undefined
      ? dueAt + DEFAULT_GOAL_LIFETIME_MS
      : Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) return reject("expiresAt is not a valid timestamp");
  if (expiresAt <= dueAt) return reject("expiresAt must be after dueAt");
  if (expiresAt > dueAt + MAX_GOAL_LIFETIME_MS) {
    return reject("expiresAt is too far after dueAt");
  }

  const dedupeKey = createGoalDedupeKey({
    title: proposal.title,
    dueAt: new Date(dueAt).toISOString(),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
  });
  const duplicate = input.existingGoals.some(
    (goal) =>
      goal.dedupeKey === dedupeKey &&
      goal.status !== "failed" &&
      goal.status !== "expired" &&
      Date.parse(goal.createdAt) >= now - DEDUPE_WINDOW_MS,
  );
  if (duplicate) return reject("duplicate goal");

  if (input.existingGoals.filter(isActiveGoal).length >= options.maxActiveGoals) {
    return reject("too many active goals");
  }

  const today = japanDateKey(now);
  const createdToday = input.existingGoals.filter(
    (goal) => japanDateKey(Date.parse(goal.createdAt)) === today,
  ).length;
  if (createdToday >= options.maxGoalsPerDay) {
    return reject("daily goal limit reached");
  }

  if (isMutedTopic(proposal, input.preferences, now)) {
    return reject("topic is muted");
  }

  return {
    action: "accept",
    dueAt: new Date(dueAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    dedupeKey,
  };
}

function isMutedTopic(
  proposal: InitiativeGoalProposal,
  preferences: ProactivePreferences,
  now: number,
): boolean {
  const text = `${proposal.title}\n${proposal.rationale}`.toLowerCase();
  return preferences.topics.some((topic) => {
    if (topic.mode !== "mute") return false;
    if (topic.until !== undefined && Date.parse(topic.until) <= now) return false;
    const normalized = topic.topic.trim().toLowerCase();
    return normalized.length > 0 && text.includes(normalized);
  });
}

function reject(reason: string): InitiativeGoalPolicyDecision {
  return { action: "reject", reason };
}
