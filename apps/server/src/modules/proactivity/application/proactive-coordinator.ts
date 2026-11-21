import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { WorkerControl } from "@agents/core/worker-agent";
import { formatSchedule } from "@modules/scheduling/domain/schedule";
import type { WatchTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { AccessScope } from "@shared/access";

import {
  formatFollowUp,
  isFollowUpExpired,
  markFollowUpDone,
  markFollowUpExpired,
  markFollowUpNotified,
  markFollowUpOrphaned,
  type FollowUp,
  type FollowUpWatcher,
} from "../domain/follow-up";
import { japanDateKey, japanTimestampForToday } from "../domain/japan-time";
import {
  decideDelivery,
  type DeliveryDecision,
  type ProactivePolicyDefaults,
} from "../domain/proactive-delivery-policy";
import {
  renderProactivePreferences,
  type ProactiveDeliveryMode,
  type ProactivePreferenceChange,
  type ProactivePreferences,
} from "../domain/proactive-preference";
import type { ProactivePreferenceTarget } from "../domain/proactive-preference-scope";
import {
  createSignalDedupeKey,
  formatSignal,
  isSignalExpired,
  markSignalDismissed,
  markSignalExpired,
  markSignalSurfaced,
  type ProactiveSignal,
} from "../domain/proactive-signal";
import type { FollowUpStore } from "../ports/follow-up-store";
import type { ProactivePreferenceStore } from "../ports/proactive-preference-store";
import type { ProactiveSignalStore } from "../ports/proactive-signal-store";

const MAX_WAITING_ON_LINES = 8;
const MAX_PENDING_SIGNALS = 5;
const SIGNAL_EVIDENCE_LIMIT = 2_000;
const SIGNAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const DIGEST_INSTRUCTION =
  "まとめて伝える候補があります。必要なものだけを選び、クラインの言葉で短く伝えてください。全部を並べる必要はありません。話す価値がなければ黙ってください。";

export interface ProactiveCoordinatorOptions {
  readonly preferenceStore: ProactivePreferenceStore;
  readonly followUpStore: FollowUpStore;
  readonly signalStore: ProactiveSignalStore;
  readonly scheduledTaskStore: ScheduledTaskStore;
  readonly workers: Pick<WorkerControl, "list">;
  readonly defaults: ProactivePolicyDefaults;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export interface ProactiveContext {
  readonly preferences?: string;
  readonly waitingOn?: string;
  readonly pendingSignals?: string;
}

export interface WatchSignalInput {
  readonly watch: WatchTask;
  readonly output: string;
  readonly now: number;
}

export interface WatchSignalResult {
  readonly decision: DeliveryDecision;
  readonly signal: ProactiveSignal;
}

export interface ProactiveDigestBatch {
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly signals: readonly ProactiveSignal[];
  readonly text: string;
}

interface ResolvedWatcher {
  readonly cadenceLabel: string;
  readonly active: boolean;
}

export class ProactiveCoordinator {
  constructor(private readonly options: ProactiveCoordinatorOptions) {}

  async getContext(input: {
    readonly channelId: string;
    readonly accessScope: AccessScope;
  }): Promise<ProactiveContext> {
    const preferences = await this.readPreferencesContext(input);
    const waitingOn = formatWaitingOn(
      await this.synchronizeFollowUps(input.channelId, input.accessScope),
    );
    const pendingSignals = await this.consumePendingSignals(input.channelId, input.accessScope);

    return {
      ...(preferences !== undefined ? { preferences } : {}),
      ...(waitingOn !== undefined ? { waitingOn } : {}),
      ...(pendingSignals !== undefined ? { pendingSignals } : {}),
    };
  }

  async ingestWatchSignal(input: WatchSignalInput): Promise<WatchSignalResult> {
    const { watch, now } = input;
    const evidenceText = input.output.slice(0, SIGNAL_EVIDENCE_LIMIT);
    const signal: ProactiveSignal = {
      version: 1,
      id: randomUUID(),
      channelId: watch.channelId,
      accessScope: watch.accessScope,
      audience: watch.accessScope === "public" ? "public" : "owner",
      source: { kind: "watch", ref: watch.id },
      topic: watch.name,
      summary: watch.message,
      ...(evidenceText.length > 0 ? { evidence: { text: evidenceText } } : {}),
      urgency: watch.priority === "urgent" ? "now" : "today",
      dedupeKey: createSignalDedupeKey({
        sourceKind: "watch",
        sourceRef: watch.id,
        topic: watch.name,
        evidence: { text: evidenceText },
      }),
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SIGNAL_LIFETIME_MS).toISOString(),
      status: "queued",
    };

    const duplicate = await this.options.signalStore.findActiveByDedupeKey(signal.dedupeKey);
    if (duplicate) {
      return { decision: { mode: "silent", reason: "duplicate" }, signal: duplicate };
    }

    const preferences = await this.options.preferenceStore.read({
      channelId: watch.channelId,
      accessScope: watch.accessScope,
    });
    const deliveredToday = await this.options.signalStore.countSurfacedSince(
      watch.channelId,
      watch.accessScope,
      japanDayStartIso(now),
    );
    const decision = decideDelivery({
      signal,
      preferences,
      defaults: this.options.defaults,
      now,
      publicChannel: watch.accessScope === "public",
      deliveredToday,
    });
    const queued: ProactiveSignal = { ...signal, delivery: { mode: decision.mode } };

    if (decision.mode === "silent") {
      const surfaced = markSignalSurfaced(queued, "silent", now);
      await this.options.signalStore.create(surfaced);
      return { decision, signal: surfaced };
    }

    await this.options.signalStore.create(queued);
    return { decision, signal: queued };
  }

  async collectDueDigests(now: number): Promise<readonly ProactiveDigestBatch[]> {
    const queued = (await this.options.signalStore.listAllQueued()).filter(
      (signal) => signal.delivery?.mode === "digest",
    );
    const groups = new Map<
      string,
      {
        readonly channelId: string;
        readonly accessScope: AccessScope;
        readonly signals: ProactiveSignal[];
      }
    >();
    for (const signal of queued) {
      const key = `${signal.channelId}\u0000${signal.accessScope}`;
      const group = groups.get(key);
      if (group) {
        group.signals.push(signal);
      } else {
        groups.set(key, {
          channelId: signal.channelId,
          accessScope: signal.accessScope,
          signals: [signal],
        });
      }
    }

    const batches: ProactiveDigestBatch[] = [];
    for (const group of groups.values()) {
      const preferences = await this.options.preferenceStore.read({
        channelId: group.channelId,
        accessScope: group.accessScope,
      });
      const digestAt = preferences.delivery.digestAt ?? this.options.defaults.digestAt;
      if (digestAt === undefined) continue;

      const digestTime = japanTimestampForToday(digestAt, now);
      if (now < digestTime) continue;

      const selected: ProactiveSignal[] = [];
      for (const signal of group.signals) {
        if (isSignalExpired(signal, now)) {
          await this.options.signalStore.update(markSignalExpired(signal, now));
          continue;
        }
        if (Date.parse(signal.observedAt) >= digestTime) continue;
        selected.push(signal);
      }
      if (selected.length === 0) continue;

      await this.markSignalsSurfaced(selected, "digest", now);
      batches.push({
        channelId: group.channelId,
        accessScope: group.accessScope,
        signals: selected,
        text: [DIGEST_INSTRUCTION, ...selected.map((signal) => formatSignal(signal))].join("\n"),
      });
    }

    return batches;
  }

  async markSignalsSurfaced(
    signals: readonly ProactiveSignal[],
    mode: ProactiveDeliveryMode,
    now: number,
  ): Promise<void> {
    for (const signal of signals) {
      await this.options.signalStore.update(markSignalSurfaced(signal, mode, now));
      if (mode === "silent") continue;
      if (signal.source.kind !== "watch" || signal.source.ref === undefined) continue;

      const followUps = await this.options.followUpStore.listByWatcher("watch", signal.source.ref);
      for (const followUp of followUps) {
        if (followUp.status !== "active" && followUp.status !== "notified") continue;
        await this.options.followUpStore.update(markFollowUpNotified(followUp, now));
      }
    }
  }

  async markWatcherCompleted(kind: FollowUpWatcher["kind"], id: string): Promise<void> {
    const now = this.now();
    const followUps = await this.options.followUpStore.listByWatcher(kind, id);
    for (const followUp of followUps) {
      if (followUp.status !== "active" && followUp.status !== "notified") continue;
      await this.options.followUpStore.update(markFollowUpDone(followUp, now));
    }
  }

  updatePreference(
    target: ProactivePreferenceTarget,
    change: ProactivePreferenceChange,
  ): Promise<ProactivePreferences> {
    return this.options.preferenceStore.update(target, change);
  }

  async createFollowUp(input: {
    readonly channelId: string;
    readonly accessScope: AccessScope;
    readonly subject: string;
    readonly watcher: FollowUpWatcher;
  }): Promise<FollowUp> {
    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw new Error("追跡する内容を指定してください。");
    }

    const resolvedWatcher = await this.resolveWatcher(
      input.watcher,
      input.channelId,
      input.accessScope,
    );
    if (!resolvedWatcher) {
      throw new Error("指定した追跡対象がこの会話に見つかりません。");
    }
    if (!resolvedWatcher.active) {
      throw new Error("指定した監視は停止中です。");
    }

    const existing = (
      await this.options.followUpStore.listForScope(input.channelId, input.accessScope)
    ).find(
      (followUp) =>
        followUp.status === "active" &&
        followUp.watcher.kind === input.watcher.kind &&
        followUp.watcher.id === input.watcher.id &&
        followUp.subject === subject,
    );
    if (existing) return existing;

    const timestamp = new Date(this.now()).toISOString();
    const followUp: FollowUp = {
      version: 1,
      id: randomUUID(),
      channelId: input.channelId,
      accessScope: input.accessScope,
      subject,
      watcher: { kind: input.watcher.kind, id: input.watcher.id },
      cadenceLabel: resolvedWatcher.cadenceLabel,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.followUpStore.create(followUp);
    return followUp;
  }

  async listFollowUps(channelId: string, accessScope: AccessScope): Promise<readonly FollowUp[]> {
    return this.synchronizeFollowUps(channelId, accessScope);
  }

  async closeFollowUp(
    channelId: string,
    accessScope: AccessScope,
    id: string,
    status: "done" | "dismissed",
  ): Promise<boolean> {
    const followUp = await this.options.followUpStore.get(id);
    if (!followUp || followUp.channelId !== channelId || followUp.accessScope !== accessScope) {
      return false;
    }

    const now = this.now();
    const updated: FollowUp =
      status === "done"
        ? markFollowUpDone(followUp, now)
        : { ...followUp, status: "dismissed", updatedAt: new Date(now).toISOString() };
    await this.options.followUpStore.update(updated);
    return true;
  }

  async listQueuedSignals(
    channelId: string,
    accessScope: AccessScope,
  ): Promise<readonly ProactiveSignal[]> {
    const now = this.now();
    const queued = await this.options.signalStore.listQueued(channelId, accessScope);
    const visible: ProactiveSignal[] = [];

    for (const signal of queued) {
      if (isSignalExpired(signal, now)) {
        await this.options.signalStore.update(markSignalExpired(signal, now));
        continue;
      }
      visible.push(signal);
    }

    return visible;
  }

  async dismissSignal(channelId: string, accessScope: AccessScope, id: string): Promise<boolean> {
    const signal = await this.options.signalStore.get(id);
    if (!signal || signal.channelId !== channelId || signal.accessScope !== accessScope) {
      return false;
    }

    await this.options.signalStore.update(markSignalDismissed(signal, this.now()));
    return true;
  }

  private async consumePendingSignals(
    channelId: string,
    accessScope: AccessScope,
  ): Promise<string | undefined> {
    const now = this.now();
    const queued = await this.options.signalStore.listQueued(channelId, accessScope, "attach");
    const selected: ProactiveSignal[] = [];

    for (const signal of queued) {
      if (isSignalExpired(signal, now)) {
        await this.options.signalStore.update(markSignalExpired(signal, now));
        continue;
      }
      if (selected.length < MAX_PENDING_SIGNALS) selected.push(signal);
    }

    if (selected.length === 0) return undefined;
    await this.markSignalsSurfaced(selected, "attach", now);
    return selected.map((signal) => formatSignal(signal)).join("\n");
  }

  private async readPreferencesContext(
    target: ProactivePreferenceTarget,
  ): Promise<string | undefined> {
    const preferences = await this.options.preferenceStore.read(target);
    return isEmptyPreferences(preferences) ? undefined : renderProactivePreferences(preferences);
  }

  private async synchronizeFollowUps(
    channelId: string,
    accessScope: AccessScope,
  ): Promise<FollowUp[]> {
    const now = this.now();
    const followUps = await this.options.followUpStore.listForScope(channelId, accessScope);
    const visible: FollowUp[] = [];

    for (const followUp of followUps) {
      if (
        followUp.status === "done" ||
        followUp.status === "dismissed" ||
        followUp.status === "expired"
      ) {
        continue;
      }

      let current = followUp;
      if (
        (current.status === "active" || current.status === "notified") &&
        isFollowUpExpired(current, now)
      ) {
        current = markFollowUpExpired(current, now);
        await this.options.followUpStore.update(current);
        this.options.logger?.debug(
          { event: "proactive_follow_up_expired", followUpId: current.id },
          "Marked a follow-up as expired",
        );
        continue;
      }

      if (current.status === "active" || current.status === "notified") {
        const watcher = await this.resolveWatcher(current.watcher, channelId, accessScope);
        if (!watcher) {
          current = markFollowUpOrphaned(current, now);
          await this.options.followUpStore.update(current);
          this.options.logger?.debug(
            { event: "proactive_follow_up_orphaned", followUpId: current.id },
            "Marked a follow-up as orphaned",
          );
        }
      }

      visible.push(current);
    }

    return visible;
  }

  private async resolveWatcher(
    watcher: FollowUpWatcher,
    channelId: string,
    accessScope: AccessScope,
  ): Promise<ResolvedWatcher | undefined> {
    switch (watcher.kind) {
      case "watch": {
        const watches = await this.options.scheduledTaskStore.listForScope(
          "watch",
          channelId,
          accessScope,
        );
        const watch = watches.find((candidate) => candidate.id === watcher.id);
        return watch
          ? { cadenceLabel: formatSchedule(watch.schedule), active: watch.enabled }
          : undefined;
      }
      case "reminder": {
        const reminders = await this.options.scheduledTaskStore.listForScope(
          "reminder",
          channelId,
          accessScope,
        );
        const reminder = reminders.find((candidate) => candidate.id === watcher.id);
        return reminder
          ? { cadenceLabel: formatSchedule(reminder.schedule), active: true }
          : undefined;
      }
      case "worker": {
        const worker = this.options.workers
          .list({ conversationKey: { kind: "discord", channelId }, accessScope })
          .find(
            (candidate) =>
              candidate.id === watcher.id &&
              (candidate.status === "running" || candidate.status === "idle"),
          );
        return worker ? { cadenceLabel: "ワーカーの完了時", active: true } : undefined;
      }
      default: {
        const exhaustive: never = watcher.kind;
        throw new Error(`追跡対象の種類が不正です: ${String(exhaustive)}`);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function formatWaitingOn(followUps: readonly FollowUp[]): string | undefined {
  if (followUps.length === 0) return undefined;
  return followUps
    .slice(0, MAX_WAITING_ON_LINES)
    .map((followUp) => formatFollowUp(followUp))
    .join("\n");
}

function isEmptyPreferences(preferences: ProactivePreferences): boolean {
  const { delivery } = preferences;
  return (
    delivery.defaultMode === undefined &&
    delivery.quietHours === undefined &&
    delivery.digestAt === undefined &&
    delivery.maxPerDay === undefined &&
    preferences.topics.length === 0 &&
    preferences.notes.length === 0
  );
}

function japanDayStartIso(now: number): string {
  return new Date(`${japanDateKey(now)}T00:00:00+09:00`).toISOString();
}
