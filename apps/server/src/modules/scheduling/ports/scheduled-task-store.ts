import type {
  ReminderTask,
  ScheduledTask,
  ScheduledTaskAccessScope,
  WatchTask,
} from "../domain/scheduled-task";

export interface ScheduledTaskStore {
  create(task: ScheduledTask): Promise<void>;
  listDue(now: number): Promise<readonly ScheduledTask[]>;
  listForScope(
    kind: "reminder",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ReminderTask[]>;
  listForScope(
    kind: "watch",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly WatchTask[]>;
  listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ScheduledTask[]>;
  delete(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
    taskId: string,
  ): Promise<boolean>;
  update(task: ScheduledTask): Promise<void>;
}
