import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseScheduledTask,
  type ReminderTask,
  type ScheduledTask,
  type WatchTask,
} from "../domain/scheduled-task";
import type { ScheduledTaskStore } from "../ports/scheduled-task-store";

export class FileScheduledTaskStore implements ScheduledTaskStore {
  constructor(private readonly directory: string) {}

  async create(task: ScheduledTask): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.write(task);
  }

  async listDue(now: number): Promise<readonly ScheduledTask[]> {
    const tasks = await this.readAll();
    return tasks
      .filter((task) => task.kind !== "watch" || task.enabled)
      .filter((task) => Date.parse(task.nextRunAt) <= now)
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
  }

  async listForScope(
    kind: "reminder",
    channelId: string,
    accessScope: ScheduledTask["accessScope"],
  ): Promise<readonly ReminderTask[]>;
  async listForScope(
    kind: "watch",
    channelId: string,
    accessScope: ScheduledTask["accessScope"],
  ): Promise<readonly WatchTask[]>;
  async listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTask["accessScope"],
  ): Promise<readonly ScheduledTask[]>;
  async listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTask["accessScope"],
  ): Promise<readonly ScheduledTask[]> {
    const tasks = await this.readAll();
    return tasks
      .filter(
        (task) =>
          task.kind === kind && task.channelId === channelId && task.accessScope === accessScope,
      )
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
  }

  async delete(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTask["accessScope"],
    taskId: string,
  ): Promise<boolean> {
    const path = this.getFilePath(taskId);
    let task: ScheduledTask;
    try {
      task = parseScheduledTask(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
    if (task.kind !== kind || task.channelId !== channelId || task.accessScope !== accessScope) {
      return false;
    }
    await rm(path);
    return true;
  }

  async update(task: ScheduledTask): Promise<void> {
    await this.write(task);
  }

  private async readAll(): Promise<ScheduledTask[]> {
    const paths = await this.getFiles();
    return Promise.all(
      paths.map(async (path) => parseScheduledTask(JSON.parse(await readFile(path, "utf8")))),
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

  private async write(task: ScheduledTask): Promise<void> {
    const path = this.getFilePath(task.id);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(taskId: string): string {
    return resolve(this.directory, `${encodeURIComponent(taskId)}.json`);
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
