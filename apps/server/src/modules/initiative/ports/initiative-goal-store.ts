import type { AccessScope } from "@shared/access";

import type { InitiativeGoal } from "../domain/initiative-goal";

export interface InitiativeGoalStore {
  create(goal: InitiativeGoal): Promise<void>;
  update(goal: InitiativeGoal): Promise<void>;
  get(id: string): Promise<InitiativeGoal | undefined>;
  listAll(): Promise<readonly InitiativeGoal[]>;
  listForScope(channelId: string, accessScope: AccessScope): Promise<readonly InitiativeGoal[]>;
  findByWorkerId(workerId: string): Promise<InitiativeGoal | undefined>;
}
