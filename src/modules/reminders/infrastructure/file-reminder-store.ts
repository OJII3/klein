import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  getNextReminderDueAt,
  REMINDER_WEEKDAYS,
  type Reminder,
  type ReminderAccessScope,
} from "../domain/reminder";
import type { ReminderStore } from "../ports/reminder-store";

export class FileReminderStore implements ReminderStore {
  constructor(private readonly directory: string) {}

  async create(reminder: Reminder): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.write(reminder);
  }

  async listForScope(
    channelId: string,
    accessScope: ReminderAccessScope,
  ): Promise<readonly Reminder[]> {
    const reminders = await this.readAll();
    return reminders
      .filter(
        (reminder) => reminder.channelId === channelId && reminder.accessScope === accessScope,
      )
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  async listDue(now: number): Promise<readonly Reminder[]> {
    const reminders = await this.readAll();
    return reminders
      .filter((reminder) => Date.parse(reminder.dueAt) <= now)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  async delete(
    channelId: string,
    accessScope: ReminderAccessScope,
    reminderId: string,
  ): Promise<boolean> {
    const path = this.getFilePath(reminderId);
    let reminder: Reminder;
    try {
      reminder = parseReminder(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
    if (reminder.channelId !== channelId || reminder.accessScope !== accessScope) return false;
    await rm(path);
    return true;
  }

  async updateDueAt(reminder: Reminder, dueAt: string): Promise<void> {
    await this.write({ ...reminder, dueAt });
  }

  private async readAll(): Promise<Reminder[]> {
    const paths = await this.getFiles();
    return Promise.all(
      paths.map(async (path) => parseReminder(JSON.parse(await readFile(path, "utf8")))),
    );
  }

  private async getFiles(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(this.directory, entry.name));
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

function parseReminder(value: unknown): Reminder {
  if (
    typeof value !== "object" ||
    value === null ||
    "sessionKey" in value ||
    "ownerFeaturesAllowed" in value ||
    !("accessScope" in value) ||
    typeof value.accessScope !== "string" ||
    !/^(?:public|owner:\d+)$/u.test(value.accessScope)
  ) {
    throw new Error("リマインダーの保存形式が不正です。旧形式には対応していません。");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.channelId !== "string" ||
    record.channelId.length === 0 ||
    typeof record.message !== "string" ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.dueAt !== "string" ||
    !Number.isFinite(Date.parse(record.dueAt)) ||
    (record.repeat !== undefined && record.repeat !== "daily" && record.repeat !== "weekly") ||
    (record.repeat !== undefined && typeof record.time !== "string") ||
    (record.repeat === "weekly" &&
      (!Array.isArray(record.weekdays) ||
        record.weekdays.length === 0 ||
        !record.weekdays.every((weekday) => REMINDER_WEEKDAYS.includes(weekday))))
  ) {
    throw new Error(
      "リマインダーの保存内容が不正です。ID・チャンネル・日時・繰り返し設定を確認してください。",
    );
  }
  const reminder = value as Reminder;
  getNextReminderDueAt(reminder, 0);
  return reminder;
}
