import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AttachedTaskScope, AttachedTaskStatus } from "@agents/core/attached-agent";
import { isConversationKey } from "@shared/conversation-key";
import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";

/** The task metadata that outlives the process. The Pi session itself lives in `sessions/attached/`. */
export interface StoredAttachedTask extends AttachedTaskScope {
  readonly id: string;
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  readonly status: AttachedTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closeAfterResult: boolean;
}

export interface AttachedTaskStore {
  list(): Promise<readonly StoredAttachedTask[]>;
  save(task: StoredAttachedTask): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Stores one JSON file per attached task. A task is restored from this file
 * after a restart, and its Pi session is resumed when the conversation sends
 * the next prompt.
 */
export class FileAttachedTaskStore implements AttachedTaskStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<readonly StoredAttachedTask[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(this.directory, entry.name));

    const tasks = await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(path, "utf8");
        try {
          return parseJson(content);
        } catch {
          return undefined;
        }
      }),
    );
    return tasks.filter((task) => isStoredAttachedTask(task));
  }

  async save(task: StoredAttachedTask): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.getFilePath(task.id);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.getFilePath(id));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }

  private getFilePath(id: string): string {
    return resolve(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

function isStoredAttachedTask(value: unknown): value is StoredAttachedTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isConversationKey(value.conversationKey) &&
    typeof value.accessScope === "string" &&
    typeof value.ownerFeaturesAllowed === "boolean" &&
    typeof value.prompt === "string" &&
    (value.status === "running" ||
      value.status === "idle" ||
      value.status === "failed" ||
      value.status === "interrupted") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.closeAfterResult === "boolean"
  );
}
