import type { AccessScope } from "@shared/access";

import type { FollowUp, FollowUpWatcher } from "../domain/follow-up";

export interface FollowUpStore {
  create(followUp: FollowUp): Promise<void>;
  update(followUp: FollowUp): Promise<void>;
  delete(id: string): Promise<boolean>;
  get(id: string): Promise<FollowUp | undefined>;
  listForScope(channelId: string, accessScope: AccessScope): Promise<readonly FollowUp[]>;
  listAll(): Promise<readonly FollowUp[]>;
  listByWatcher(kind: FollowUpWatcher["kind"], id: string): Promise<readonly FollowUp[]>;
}
