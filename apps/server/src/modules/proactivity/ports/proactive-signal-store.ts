import type { AccessScope } from "@shared/access";

import type { ProactiveDeliveryMode } from "../domain/proactive-preference";
import type { ProactiveSignal } from "../domain/proactive-signal";

export interface ProactiveSignalStore {
  create(signal: ProactiveSignal): Promise<void>;
  update(signal: ProactiveSignal): Promise<void>;
  get(id: string): Promise<ProactiveSignal | undefined>;
  findActiveByDedupeKey(dedupeKey: string): Promise<ProactiveSignal | undefined>;
  listQueued(
    channelId: string,
    accessScope: AccessScope,
    mode?: ProactiveDeliveryMode,
  ): Promise<readonly ProactiveSignal[]>;
  listAll(): Promise<readonly ProactiveSignal[]>;
  listAllQueued(): Promise<readonly ProactiveSignal[]>;
  countSurfacedSince(channelId: string, accessScope: AccessScope, since: string): Promise<number>;
}
