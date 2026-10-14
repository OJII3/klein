import type { Reminder } from "../domain/reminder";

export interface ReminderStore {
  create(reminder: Reminder): Promise<void>;
  listForSession(sessionKey: string): Promise<readonly Reminder[]>;
  listDue(now: number): Promise<readonly Reminder[]>;
  delete(sessionKey: string, reminderId: string): Promise<boolean>;
  updateDueAt(reminder: Reminder, dueAt: string): Promise<void>;
}
