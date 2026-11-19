import { readFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Logger } from "pino";

import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";

import {
  sharedMemoryScopeKey,
  isValidSharedMemoryId,
  type SharedMemory,
  type SharedMemoryScope,
} from "../domain/shared-memory";
import { MarkdownSharedMemoryStore } from "./markdown-shared-memory-store";

const LEGACY_FILE_NAME = "MEMORY.json";
const MIGRATED_FILE_NAME = "MEMORY.json.migrated";

export async function migrateLegacySharedMemory(
  directory: string,
  logger?: Pick<Logger, "info" | "warn">,
): Promise<void> {
  const root = resolve(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw new Error(`Failed to list shared memory directory: ${root}`, { cause: error });
  }

  const store = new MarkdownSharedMemoryStore(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSharedMemoryId(entry.name)) continue;
    const legacyPath = join(root, entry.name, LEGACY_FILE_NAME);

    let content: string;
    try {
      content = await readFile(legacyPath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw new Error(`Failed to read legacy shared memory file: ${legacyPath}`, { cause: error });
    }

    let legacyEntries;
    try {
      legacyEntries = parseLegacyEntries(content);
    } catch (error) {
      logger?.warn(
        { err: error, event: "shared_memory_migration_failed", path: legacyPath },
        "Failed to parse legacy shared memory",
      );
      continue;
    }

    const memories = groupLegacyEntries(legacyEntries);
    for (const { memory, scope } of memories) {
      const existing = await store.read(entry.name, scope);
      if (existing.facts.length > 0 || existing.preferences.length > 0) continue;
      await store.write(entry.name, scope, memory);
    }

    await rename(legacyPath, join(root, entry.name, MIGRATED_FILE_NAME));
    logger?.info(
      {
        event: "shared_memory_migrated",
        guildId: entry.name,
        scopeCount: memories.length,
      },
      "Migrated legacy shared memory",
    );
  }
}

interface LegacyMemoryEntry {
  readonly scope: {
    readonly type: string;
    readonly channelId?: string;
    readonly threadId?: string;
  };
  readonly title: string;
  readonly content: string;
}

function parseLegacyEntries(content: string): LegacyMemoryEntry[] {
  let value: unknown;
  try {
    value = parseJson(content);
  } catch (error) {
    throw new Error("Legacy shared memory file contains invalid JSON", { cause: error });
  }

  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Legacy shared memory file contains an invalid document");
  }

  return value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.title !== "string" ||
      typeof entry.content !== "string" ||
      !isRecord(entry.scope) ||
      typeof entry.scope.type !== "string"
    ) {
      throw new Error("Legacy shared memory file contains a malformed entry");
    }

    return {
      content: entry.content,
      scope: {
        type: entry.scope.type,
        ...(typeof entry.scope.channelId === "string" ? { channelId: entry.scope.channelId } : {}),
        ...(typeof entry.scope.threadId === "string" ? { threadId: entry.scope.threadId } : {}),
      },
      title: entry.title,
    };
  });
}

function groupLegacyEntries(
  entries: readonly LegacyMemoryEntry[],
): { readonly memory: SharedMemory; readonly scope: SharedMemoryScope }[] {
  const groups = new Map<
    string,
    { readonly scope: SharedMemoryScope; readonly facts: string[]; readonly preferences: string[] }
  >();

  for (const entry of entries) {
    const scope = parseLegacyScope(entry.scope);
    if (!scope) continue;

    const key = sharedMemoryScopeKey(scope);
    const group = groups.get(key) ?? { facts: [], preferences: [], scope };
    group.facts.push(entry.title ? `${entry.title}: ${entry.content}` : entry.content);
    groups.set(key, group);
  }

  return [...groups.values()].map(({ facts, preferences, scope }) => ({
    memory: { facts, preferences },
    scope,
  }));
}

function parseLegacyScope(scope: {
  readonly type: string;
  readonly channelId?: string;
  readonly threadId?: string;
}): SharedMemoryScope | undefined {
  if (scope.type === "guild") return { type: "guild" };
  if (scope.type === "channel" && scope.channelId && isValidSharedMemoryId(scope.channelId)) {
    return { channelId: scope.channelId, type: "channel" };
  }
  if (
    scope.type === "thread" &&
    scope.channelId &&
    scope.threadId &&
    isValidSharedMemoryId(scope.channelId) &&
    isValidSharedMemoryId(scope.threadId)
  ) {
    return { channelId: scope.channelId, threadId: scope.threadId, type: "thread" };
  }
  return undefined;
}
