import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AttachedTaskScope, AttachedTaskStatus } from "@agents/core/attached-agent";
import { isConversationKey } from "@shared/conversation-key";

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
          return JSON.parse(content) as unknown;
        } catch {
          return undefined;
        }
      }),
    );
    return tasks.filter(isStoredAttachedTask);
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
  if (typeof value !== "object" || value === null) return false;
  const task = value as Partial<StoredAttachedTask>;
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
    isConversationKey(task.conversationKey) &&
    typeof task.accessScope === "string" &&
    typeof task.ownerFeaturesAllowed === "boolean" &&
    typeof task.prompt === "string" &&
    (task.status === "running" ||
      task.status === "idle" ||
      task.status === "failed" ||
      task.status === "interrupted") &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string" &&
    typeof task.closeAfterResult === "boolean"
  );
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
