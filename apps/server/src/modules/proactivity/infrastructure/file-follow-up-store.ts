import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AccessScope } from "@shared/access";
import { readJsonRecord } from "@shared/record-file";
import { isFileNotFound } from "@shared/type-guards";

import { parseFollowUp, type FollowUp, type FollowUpWatcher } from "../domain/follow-up";
import type { FollowUpStore } from "../ports/follow-up-store";

export class FileFollowUpStore implements FollowUpStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async create(followUp: FollowUp): Promise<void> {
    await this.write(followUp);
  }

  async update(followUp: FollowUp): Promise<void> {
    await this.write(followUp);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.getFilePath(id));
      return true;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
  }

  async get(id: string): Promise<FollowUp | undefined> {
    return readJsonRecord(this.getFilePath(id), parseFollowUp);
  }

  async listForScope(channelId: string, accessScope: AccessScope): Promise<readonly FollowUp[]> {
    const followUps = await this.readAll();
    return followUps
      .filter(
        (followUp) => followUp.channelId === channelId && followUp.accessScope === accessScope,
      )
      .toSorted(compareFollowUps);
  }

  async listAll(): Promise<readonly FollowUp[]> {
    return (await this.readAll()).toSorted(compareFollowUps);
  }

  async listByWatcher(kind: FollowUpWatcher["kind"], id: string): Promise<readonly FollowUp[]> {
    const followUps = await this.readAll();
    return followUps
      .filter((followUp) => followUp.watcher.kind === kind && followUp.watcher.id === id)
      .toSorted(compareFollowUps);
  }

  private async readAll(): Promise<FollowUp[]> {
    const paths = await this.getFiles();
    const followUps = await Promise.all(paths.map((path) => readJsonRecord(path, parseFollowUp)));
    return followUps.filter((followUp): followUp is FollowUp => followUp !== undefined);
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

  private async write(followUp: FollowUp): Promise<void> {
    const path = this.getFilePath(followUp.id);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(followUp, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(id: string): string {
    return resolve(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

function compareFollowUps(left: FollowUp, right: FollowUp): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
