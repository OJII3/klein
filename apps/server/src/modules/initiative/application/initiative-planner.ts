import type { AccessScope } from "@shared/access";
import type { ProactivePreferences } from "@modules/proactivity/domain/proactive-preference";

import type { InitiativeGoal, InitiativeGoalProposal } from "../domain/initiative-goal";
import type { ConversationTranscriptMessage } from "../ports/conversation-transcript-reader";

export interface InitiativePlannerInput {
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly now: number;
  readonly messages: readonly ConversationTranscriptMessage[];
  readonly existingGoals: readonly InitiativeGoal[];
  readonly preferences: ProactivePreferences;
  readonly userMemory?: string;
  readonly sharedMemory?: string;
  readonly maxGoals: number;
}

export interface InitiativePlanner {
  plan(input: InitiativePlannerInput): Promise<readonly InitiativeGoalProposal[]>;
}
