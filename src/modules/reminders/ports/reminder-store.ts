import type { Reminder, ReminderAccessScope } from "../domain/reminder";

export interface ReminderStore {
  create(reminder: Reminder): Promise<void>;
  listForScope(channelId: string, accessScope: ReminderAccessScope): Promise<readonly Reminder[]>;
  listDue(now: number): Promise<readonly Reminder[]>;
  delete(channelId: string, accessScope: ReminderAccessScope, reminderId: string): Promise<boolean>;
  updateDueAt(reminder: Reminder, dueAt: string): Promise<void>;
}
