export type ProactiveDeliveryMode = "interrupt" | "attach" | "digest" | "silent";

export type ProactiveTopicMode = "allow" | "mute" | "urgent-only";

export type ProactiveUrgency = "now" | "today" | "digest" | "silent";

export type ProactiveSignalStatus = "queued" | "surfaced" | "dismissed" | "expired";

export type FollowUpStatus = "active" | "notified" | "done" | "orphaned" | "expired" | "dismissed";

export type FollowUpWatcherKind = "watch" | "reminder" | "worker";

export interface ProactiveSignalView {
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: string;
  readonly audience: "owner" | "public";
  readonly source: {
    readonly kind: "watch" | "worker" | "memory" | "connector" | "goal";
    readonly ref?: string;
  };
  readonly topic: string;
  readonly summary: string;
  readonly evidence?: { readonly url?: string; readonly text?: string };
  readonly urgency: ProactiveUrgency;
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly status: ProactiveSignalStatus;
  readonly deliveryMode?: ProactiveDeliveryMode;
  readonly surfacedAt?: string;
}

export interface FollowUpView {
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: string;
  readonly subject: string;
  readonly watcher: { readonly kind: FollowUpWatcherKind; readonly id: string };
  readonly cadenceLabel: string;
  readonly status: FollowUpStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly lastNotifiedAt?: string;
}

export interface ProactivePreferenceView {
  /** File key such as `user-123` or `channel-456`. */
  readonly key: string;
  readonly scope: "user" | "channel";
  readonly userId?: string;
  readonly channelId?: string;
  readonly delivery: {
    readonly defaultMode?: ProactiveDeliveryMode;
    readonly quietHours?: { readonly start: string; readonly end: string };
    readonly digestAt?: string;
    readonly maxPerDay?: number;
  };
  readonly topics: readonly {
    readonly topic: string;
    readonly mode: ProactiveTopicMode;
    readonly until?: string;
  }[];
  readonly notes: readonly string[];
}

export type InitiativeGoalStatus =
  "scheduled" | "running" | "ready" | "delivered" | "dismissed" | "expired" | "failed";

export type InitiativeGoalRisk = "low" | "medium" | "high";

export type InitiativeGoalDelivery = "interrupt" | "attach" | "digest" | "silent";

export interface InitiativeGoalView {
  readonly id: string;
  readonly channelId: string;
  readonly accessScope: string;
  readonly title: string;
  readonly rationale: string;
  readonly plan: string;
  readonly dueAt: string;
  readonly expiresAt: string;
  readonly risk: InitiativeGoalRisk;
  readonly deliveryMode?: InitiativeGoalDelivery;
  readonly status: InitiativeGoalStatus;
  readonly createdBy: "planner" | "conversation";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workerId?: string;
  readonly signalId?: string;
  readonly lastError?: string;
}

export interface ProactivitySnapshot {
  readonly signals: readonly ProactiveSignalView[];
  readonly signalsTruncated: boolean;
  readonly followUps: readonly FollowUpView[];
  readonly goals: readonly InitiativeGoalView[];
  readonly preferences: readonly ProactivePreferenceView[];
}

export interface ProactivityReport extends ProactivitySnapshot {
  readonly enabled: boolean;
}

export interface ProactivityReader {
  read(): Promise<ProactivitySnapshot>;
}
