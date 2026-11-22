import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AccessScope } from "@shared/access";
import { isFileNotFound, parseJson } from "@shared/type-guards";

import { parseInitiativeGoal, type InitiativeGoal } from "../domain/initiative-goal";
import type { InitiativeGoalStore } from "../ports/initiative-goal-store";

export class FileInitiativeGoalStore implements InitiativeGoalStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async create(goal: InitiativeGoal): Promise<void> {
    await this.write(goal);
  }

  async update(goal: InitiativeGoal): Promise<void> {
    await this.write(goal);
  }

  async get(id: string): Promise<InitiativeGoal | undefined> {
    const path = this.getFilePath(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    return parseInitiativeGoal(parseJson(raw));
  }

  async listAll(): Promise<readonly InitiativeGoal[]> {
    return (await this.readAll()).toSorted(compareGoals);
  }

  async listForScope(
    channelId: string,
    accessScope: AccessScope,
  ): Promise<readonly InitiativeGoal[]> {
    const goals = await this.readAll();
    return goals
      .filter((goal) => goal.channelId === channelId && goal.accessScope === accessScope)
      .toSorted(compareGoals);
  }

  async findByWorkerId(workerId: string): Promise<InitiativeGoal | undefined> {
    const goals = await this.readAll();
    return goals.find((goal) => goal.workerId === workerId);
  }

  private async readAll(): Promise<InitiativeGoal[]> {
    const paths = await this.getFiles();
    return Promise.all(
      paths.map(async (path) => parseInitiativeGoal(parseJson(await readFile(path, "utf8")))),
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

  private async write(goal: InitiativeGoal): Promise<void> {
    const path = this.getFilePath(goal.id);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(id: string): string {
    return resolve(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

function compareGoals(left: InitiativeGoal, right: InitiativeGoal): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
