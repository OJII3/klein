import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseAccessScope, type AccessScope } from "@shared/access";
import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";

import type { PlannerState, PlannerStateStore } from "../ports/planner-state-store";

export class FilePlannerStateStore implements PlannerStateStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async get(channelId: string, accessScope: AccessScope): Promise<PlannerState | undefined> {
    const path = this.getFilePath(channelId, accessScope);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    return parsePlannerState(parseJson(raw), channelId, accessScope);
  }

  async save(state: PlannerState): Promise<void> {
    const path = this.getFilePath(state.channelId, state.accessScope);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private getFilePath(channelId: string, accessScope: AccessScope): string {
    return resolve(this.directory, `${encodeURIComponent(`${channelId}:${accessScope}`)}.json`);
  }
}

function parsePlannerState(
  value: unknown,
  channelId: string,
  accessScope: AccessScope,
): PlannerState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.channelId !== channelId ||
    parseAccessScope(value.accessScope) !== accessScope ||
    typeof value.plansToday !== "number" ||
    !Number.isInteger(value.plansToday) ||
    value.plansToday < 0
  ) {
    throw new Error("Planner の保存内容が不正です。");
  }

  return {
    version: 1,
    channelId,
    accessScope,
    ...optionalText(value, "lastMessageId"),
    ...optionalText(value, "lastSessionKey"),
    ...optionalTimestamp(value, "lastPlannedAt"),
    ...optionalTimestamp(value, "lastAttemptAt"),
    ...optionalText(value, "plansOnDate"),
    plansToday: value.plansToday,
  };
}

function optionalText(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`Planner の${key}が不正です。`);
  }
  return { [key]: entry };
}

function optionalTimestamp(value: Record<string, unknown>, key: string): Record<string, string> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== "string" || !Number.isFinite(Date.parse(entry))) {
    throw new TypeError(`Planner の${key}が不正です。`);
  }
  return { [key]: entry };
}
