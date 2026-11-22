import type {
  FollowUpView,
  InitiativeGoalView,
  ProactivePreferenceView,
  ProactiveSignalView,
  ProactivityReader,
  ProactivitySnapshot,
} from "@klein/webui-api";

import type { InitiativeGoal } from "@modules/initiative/domain/initiative-goal";
import type { InitiativeGoalStore } from "@modules/initiative/ports/initiative-goal-store";
import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { FollowUpStore } from "@modules/proactivity/ports/follow-up-store";
import type {
  ProactivePreferenceStore,
  StoredProactivePreferences,
} from "@modules/proactivity/ports/proactive-preference-store";
import type { ProactiveSignalStore } from "@modules/proactivity/ports/proactive-signal-store";

const DEFAULT_SIGNAL_LIMIT = 200;

export interface ProactivityStoreReaderOptions {
  readonly preferenceStore: ProactivePreferenceStore;
  readonly followUpStore: FollowUpStore;
  readonly signalStore: ProactiveSignalStore;
  readonly goalStore?: Pick<InitiativeGoalStore, "listAll">;
  readonly signalLimit?: number;
}

/** Reads the proactivity ledger through its stores for the Web UI. */
export class ProactivityStoreReader implements ProactivityReader {
  private readonly signalLimit: number;

  constructor(private readonly options: ProactivityStoreReaderOptions) {
    this.signalLimit = options.signalLimit ?? DEFAULT_SIGNAL_LIMIT;
  }

  async read(): Promise<ProactivitySnapshot> {
    const [signals, followUps, goals, preferences] = await Promise.all([
      this.options.signalStore.listAll(),
      this.options.followUpStore.listAll(),
      this.options.goalStore?.listAll() ?? [],
      this.options.preferenceStore.list(),
    ]);
    const sortedSignals = signals.toSorted(compareSignalsNewestFirst);

    return {
      signals: sortedSignals.slice(0, this.signalLimit).map((signal) => toSignalView(signal)),
      signalsTruncated: sortedSignals.length > this.signalLimit,
      followUps: followUps
        .toSorted(compareFollowUpsNewestFirst)
        .map((followUp) => toFollowUpView(followUp)),
      goals: goals.toSorted(compareGoalsNewestFirst).map((goal) => toGoalView(goal)),
      preferences: preferences
        .flatMap((stored) => {
          const view = toPreferenceView(stored);
          return view === undefined ? [] : [view];
        })
        .toSorted((left, right) => left.key.localeCompare(right.key)),
    };
  }
}

function toSignalView(signal: ProactiveSignal): ProactiveSignalView {
  return {
    id: signal.id,
    channelId: signal.channelId,
    accessScope: signal.accessScope,
    audience: signal.audience,
    source: signal.source,
    topic: signal.topic,
    summary: signal.summary,
    ...(signal.evidence !== undefined ? { evidence: signal.evidence } : {}),
    urgency: signal.urgency,
    observedAt: signal.observedAt,
    ...(signal.expiresAt !== undefined ? { expiresAt: signal.expiresAt } : {}),
    status: signal.status,
    ...(signal.delivery !== undefined ? { deliveryMode: signal.delivery.mode } : {}),
    ...(signal.delivery?.surfacedAt !== undefined
      ? { surfacedAt: signal.delivery.surfacedAt }
      : {}),
  };
}

function toFollowUpView(followUp: FollowUp): FollowUpView {
  return {
    id: followUp.id,
    channelId: followUp.channelId,
    accessScope: followUp.accessScope,
    subject: followUp.subject,
    watcher: followUp.watcher,
    cadenceLabel: followUp.cadenceLabel,
    status: followUp.status,
    createdAt: followUp.createdAt,
    updatedAt: followUp.updatedAt,
    ...(followUp.expiresAt !== undefined ? { expiresAt: followUp.expiresAt } : {}),
    ...(followUp.lastNotifiedAt !== undefined ? { lastNotifiedAt: followUp.lastNotifiedAt } : {}),
  };
}

function toGoalView(goal: InitiativeGoal): InitiativeGoalView {
  return {
    id: goal.id,
    channelId: goal.channelId,
    accessScope: goal.accessScope,
    title: goal.title,
    rationale: goal.rationale,
    plan: goal.plan,
    dueAt: goal.dueAt,
    expiresAt: goal.expiresAt,
    risk: goal.risk,
    ...(goal.delivery !== undefined ? { deliveryMode: goal.delivery } : {}),
    status: goal.status,
    createdBy: goal.createdBy,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.workerId !== undefined ? { workerId: goal.workerId } : {}),
    ...(goal.signalId !== undefined ? { signalId: goal.signalId } : {}),
    ...(goal.lastError !== undefined ? { lastError: goal.lastError } : {}),
  };
}

function toPreferenceView(stored: StoredProactivePreferences): ProactivePreferenceView | undefined {
  const preferences = {
    delivery: stored.preferences.delivery,
    topics: stored.preferences.topics,
    notes: stored.preferences.notes,
  };
  if (stored.key.startsWith("user-")) {
    return {
      key: stored.key,
      scope: "user",
      userId: decodeKeyPart(stored.key.slice("user-".length)),
      ...preferences,
    };
  }
  if (stored.key.startsWith("channel-")) {
    return {
      key: stored.key,
      scope: "channel",
      channelId: decodeKeyPart(stored.key.slice("channel-".length)),
      ...preferences,
    };
  }
  return undefined;
}

function decodeKeyPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compareSignalsNewestFirst(left: ProactiveSignal, right: ProactiveSignal): number {
  return right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id);
}

function compareFollowUpsNewestFirst(left: FollowUp, right: FollowUp): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function compareGoalsNewestFirst(left: InitiativeGoal, right: InitiativeGoal): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}
