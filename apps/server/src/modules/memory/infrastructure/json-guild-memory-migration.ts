import { readFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Logger } from "pino";

import { isFileNotFound } from "@shared/type-guards";

import {
  guildMemoryScopeKey,
  isValidGuildMemoryId,
  type GuildMemory,
  type GuildMemoryScope,
} from "../domain/guild-memory";
import { parseMemoryDocument } from "./json-memory-store";
import { MarkdownGuildMemoryStore } from "./markdown-guild-memory-store";

const LEGACY_FILE_NAME = "MEMORY.json";
const MIGRATED_FILE_NAME = "MEMORY.json.migrated";

export async function migrateLegacyGuildMemory(
  directory: string,
  logger?: Pick<Logger, "info" | "warn">,
): Promise<void> {
  const root = resolve(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw new Error(`Failed to list guild memory directory: ${root}`, { cause: error });
  }

  const store = new MarkdownGuildMemoryStore(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidGuildMemoryId(entry.name)) continue;
    const legacyPath = join(root, entry.name, LEGACY_FILE_NAME);

    let content: string;
    try {
      content = await readFile(legacyPath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw new Error(`Failed to read legacy guild memory file: ${legacyPath}`, { cause: error });
    }

    let legacyEntries;
    try {
      legacyEntries = parseMemoryDocument(content).entries;
    } catch (error) {
      logger?.warn(
        { err: error, event: "guild_memory_migration_failed", path: legacyPath },
        "Failed to parse legacy guild memory",
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
        event: "guild_memory_migrated",
        guildId: entry.name,
        scopeCount: memories.length,
      },
      "Migrated legacy guild memory",
    );
  }
}

function groupLegacyEntries(
  entries: readonly {
    readonly scope: {
      readonly type: string;
      readonly channelId?: string;
      readonly threadId?: string;
    };
    readonly title: string;
    readonly content: string;
  }[],
): { readonly memory: GuildMemory; readonly scope: GuildMemoryScope }[] {
  const groups = new Map<
    string,
    { readonly scope: GuildMemoryScope; readonly facts: string[]; readonly preferences: string[] }
  >();

  for (const entry of entries) {
    const scope = parseLegacyScope(entry.scope);
    if (!scope) continue;

    const key = guildMemoryScopeKey(scope);
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
}): GuildMemoryScope | undefined {
  if (scope.type === "guild") return { type: "guild" };
  if (scope.type === "channel" && scope.channelId && isValidGuildMemoryId(scope.channelId)) {
    return { channelId: scope.channelId, type: "channel" };
  }
  if (
    scope.type === "thread" &&
    scope.channelId &&
    scope.threadId &&
    isValidGuildMemoryId(scope.channelId) &&
    isValidGuildMemoryId(scope.threadId)
  ) {
    return { channelId: scope.channelId, threadId: scope.threadId, type: "thread" };
  }
  return undefined;
}
