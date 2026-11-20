import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerScope, WorkerStatus } from "@agents/core/worker-agent";
import { parseAccessScope } from "@shared/access";
import { isConversationKey } from "@shared/conversation-key";
import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";

/** The worker metadata that outlives the process. The Pi session itself lives in `sessions/worker/`. */
export interface StoredWorker extends WorkerScope {
  readonly id: string;
  readonly ownerFeaturesAllowed: boolean;
  readonly prompt: string;
  readonly status: WorkerStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closeAfterResult: boolean;
}

export interface WorkerStore {
  list(): Promise<readonly StoredWorker[]>;
  save(worker: StoredWorker): Promise<void>;
  delete(id: string): Promise<void>;
}
export class FileWorkerStore implements WorkerStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<readonly StoredWorker[]> {
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

    const workers = await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(path, "utf8");
        try {
          return parseJson(content);
        } catch {
          return undefined;
        }
      }),
    );
    return workers.filter((worker) => isStoredWorker(worker));
  }

  async save(worker: StoredWorker): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.getFilePath(worker.id);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(worker, null, 2)}\n`, "utf8");
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

function isStoredWorker(value: unknown): value is StoredWorker {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isConversationKey(value.conversationKey) &&
    parseAccessScope(value.accessScope) !== undefined &&
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
