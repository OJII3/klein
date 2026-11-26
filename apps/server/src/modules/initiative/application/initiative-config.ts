import { resolve } from "node:path";

import type { AppConfig } from "@app/config-schema";

const DEFAULT_PLAN_AFTER_IDLE_MINUTES = 30;
const DEFAULT_PLAN_WITHIN_HOURS = 48;
const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_MAX_PLANS_PER_DAY = 12;
const DEFAULT_MAX_GOALS_PER_DAY = 4;
const DEFAULT_MAX_ACTIVE_GOALS = 3;
const DEFAULT_MAX_GOALS_PER_PLAN = 2;
const DEFAULT_START_LEAD_MINUTES = 2;
const MINUTE_MS = 60 * 1_000;

export type InitiativeApprovalMode = "auto" | "propose" | "off";

export interface ResolvedInitiativeConfig {
  readonly enabled: boolean;
  readonly goalsDirectory: string;
  readonly plannerStateDirectory: string;
  readonly llm: Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;
  readonly planAfterIdleMinutes: number;
  readonly planWithinHours: number;
  readonly maxMessages: number;
  readonly maxPlansPerDay: number;
  readonly maxGoalsPerDay: number;
  readonly maxActiveGoals: number;
  readonly maxGoalsPerPlan: number;
  readonly startLeadMs: number;
  readonly approval: InitiativeApprovalMode;
}

export function resolveInitiativeConfig(
  config: AppConfig,
  stateDir: string,
  proactivityEnabled: boolean,
): ResolvedInitiativeConfig {
  const initiative = config.features.proactivity?.initiative;
  const llm = initiative?.llm ?? config.llm;
  const enabled = proactivityEnabled && (initiative?.enabled ?? false);
  if (enabled && initiative?.approval === "propose") {
    throw new Error(
      "features.proactivity.initiative.approval: propose is not implemented yet; use auto or off",
    );
  }

  return {
    enabled,
    goalsDirectory: resolve(initiative?.goalsDirectory ?? resolve(stateDir, "initiative/goals")),
    plannerStateDirectory: resolve(
      initiative?.plannerStateDirectory ?? resolve(stateDir, "initiative/planner"),
    ),
    llm: {
      provider: llm.provider,
      model: llm.model,
      ...(llm.thinkingLevel !== undefined ? { thinkingLevel: llm.thinkingLevel } : {}),
    },
    planAfterIdleMinutes: initiative?.planAfterIdleMinutes ?? DEFAULT_PLAN_AFTER_IDLE_MINUTES,
    planWithinHours: initiative?.planWithinHours ?? DEFAULT_PLAN_WITHIN_HOURS,
    maxMessages: initiative?.maxMessages ?? DEFAULT_MAX_MESSAGES,
    maxPlansPerDay: initiative?.maxPlansPerDay ?? DEFAULT_MAX_PLANS_PER_DAY,
    maxGoalsPerDay: initiative?.maxGoalsPerDay ?? DEFAULT_MAX_GOALS_PER_DAY,
    maxActiveGoals: initiative?.maxActiveGoals ?? DEFAULT_MAX_ACTIVE_GOALS,
    maxGoalsPerPlan: initiative?.maxGoalsPerPlan ?? DEFAULT_MAX_GOALS_PER_PLAN,
    startLeadMs: (initiative?.startLeadMinutes ?? DEFAULT_START_LEAD_MINUTES) * MINUTE_MS,
    approval: initiative?.approval ?? "auto",
  };
}
