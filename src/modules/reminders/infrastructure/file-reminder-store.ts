import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Reminder } from "../domain/reminder";
import type { ReminderStore } from "../ports/reminder-store";

export class FileReminderStore implements ReminderStore {
  constructor(private readonly directory: string) {}

  async create(reminder: Reminder): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.write(reminder);
  }

  async listForSession(sessionKey: string): Promise<readonly Reminder[]> {
    const reminders = await this.readAll();
    return reminders
      .filter((reminder) => reminder.sessionKey === sessionKey)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  async listDue(now: number): Promise<readonly Reminder[]> {
    const reminders = await this.readAll();
    return reminders
      .filter((reminder) => Date.parse(reminder.dueAt) <= now)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  async delete(sessionKey: string, reminderId: string): Promise<boolean> {
    const path = this.getFilePath(reminderId);
    let reminder: Reminder;
    try {
      reminder = JSON.parse(await readFile(path, "utf8")) as Reminder;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
    if (reminder.sessionKey !== sessionKey) return false;
    await rm(path);
    return true;
  }

  async updateDueAt(reminder: Reminder, dueAt: string): Promise<void> {
    await this.write({ ...reminder, dueAt });
  }

  private async readAll(): Promise<Reminder[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(this.directory, entry.name));
    return Promise.all(
      files.map(async (path) => JSON.parse(await readFile(path, "utf8")) as Reminder),
    );
  }

  private async write(reminder: Reminder): Promise<void> {
    const path = this.getFilePath(reminder.id);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(reminder, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(reminderId: string): string {
    return resolve(this.directory, `${encodeURIComponent(reminderId)}.json`);
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
