import type { AccessScope } from "@shared/access";

export interface PlannerState {
  readonly version: 1;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly lastMessageId?: string;
  readonly lastSessionKey?: string;
  readonly lastPlannedAt?: string;
  readonly lastAttemptAt?: string;
  readonly plansOnDate?: string;
  readonly plansToday: number;
}

export interface PlannerStateStore {
  get(channelId: string, accessScope: AccessScope): Promise<PlannerState | undefined>;
  save(state: PlannerState): Promise<void>;
}
