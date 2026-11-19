import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AttachedTaskControl } from "@agents/core/attached-agent";
import { formatSchedule } from "@modules/scheduling/domain/schedule";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { AccessScope } from "@shared/access";

import {
  formatFollowUp,
  isFollowUpExpired,
  markFollowUpDone,
  markFollowUpExpired,
  markFollowUpOrphaned,
  type FollowUp,
  type FollowUpWatcher,
} from "../domain/follow-up";
import {
  renderProactivePreferences,
  type ProactivePreferenceChange,
  type ProactivePreferences,
} from "../domain/proactive-preference";
import type { FollowUpStore } from "../ports/follow-up-store";
import type { ProactivePreferenceStore } from "../ports/proactive-preference-store";

const MAX_WAITING_ON_LINES = 8;

export interface ProactiveCoordinatorOptions {
  readonly preferenceStore: ProactivePreferenceStore;
  readonly followUpStore: FollowUpStore;
  readonly scheduledTaskStore: ScheduledTaskStore;
  readonly attachedTasks: Pick<AttachedTaskControl, "list">;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export interface ProactiveContext {
  readonly preferences?: string;
  readonly waitingOn?: string;
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
    const preferences =
      input.accessScope === "public" ? undefined : await this.readPreferencesContext();
    const waitingOn = formatWaitingOn(
      await this.synchronizeFollowUps(input.channelId, input.accessScope),
    );

    return {
      ...(preferences !== undefined ? { preferences } : {}),
      ...(waitingOn !== undefined ? { waitingOn } : {}),
    };
  }

  updatePreference(change: ProactivePreferenceChange): Promise<ProactivePreferences> {
    return this.options.preferenceStore.update(change);
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

  private async readPreferencesContext(): Promise<string | undefined> {
    const preferences = await this.options.preferenceStore.read();
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
      case "task": {
        const task = this.options.attachedTasks
          .list({ conversationKey: { kind: "discord", channelId }, accessScope })
          .find(
            (candidate) =>
              candidate.id === watcher.id &&
              (candidate.status === "running" || candidate.status === "idle"),
          );
        return task ? { cadenceLabel: "タスクの完了時", active: true } : undefined;
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
