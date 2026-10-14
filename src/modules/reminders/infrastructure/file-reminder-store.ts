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

  async migrateLegacyReminders(): Promise<number> {
    const paths = await this.getFiles();
    const migrations: Reminder[] = [];
    for (const path of paths) {
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      const isLegacy =
        typeof record === "object" &&
        record !== null &&
        ("sessionKey" in record || "ownerFeaturesAllowed" in record);
      const reminder = isLegacy
        ? migrateLegacyReminder(record as Record<string, unknown>)
        : parseReminder(record);
      if (path !== this.getFilePath(reminder.id)) {
        throw new Error(
          `リマインダー ${reminder.id} のファイル名がIDと一致しません。保存ファイルを確認してください。`,
        );
      }
      if (isLegacy) migrations.push(reminder);
    }
    for (const reminder of migrations) await this.write(reminder);
    return migrations.length;
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
    throw new Error("リマインダーの保存形式が不正です。旧形式は起動時の移行を完了してください。");
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

function migrateLegacyReminder(record: Record<string, unknown>): Reminder {
  const { sessionKey, ownerFeaturesAllowed, ...fields } = record;
  if (
    typeof sessionKey !== "string" ||
    typeof record.channelId !== "string" ||
    typeof ownerFeaturesAllowed !== "boolean" ||
    "accessScope" in record
  ) {
    throw new Error(
      `リマインダー ${String(record.id)} の旧保存形式が不正です。保存ファイルを確認してください。`,
    );
  }
  const prefix = `discord-channel:${record.channelId}`;
  const suffix = sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : undefined;
  const match =
    suffix === undefined
      ? null
      : /^(?::(public|owner:\d+))?(?::rotation:\d{4}-\d{2}-\d{2})?$/u.exec(suffix);
  const scope = match?.[1];
  if (
    !match ||
    (ownerFeaturesAllowed && !scope?.startsWith("owner:")) ||
    (!ownerFeaturesAllowed && scope?.startsWith("owner:"))
  ) {
    throw new Error(
      `リマインダー ${String(record.id)} の所有者を確定できません。保存ファイルの sessionKey に登録時の owner ユーザーIDを明示し、ownerFeaturesAllowed との整合性を確認してください。データは移行していません。`,
    );
  }
  return parseReminder({ ...fields, accessScope: scope ?? "public" });
}
