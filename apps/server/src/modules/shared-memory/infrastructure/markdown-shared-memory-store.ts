import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isFileNotFound } from "@shared/type-guards";

import {
  sharedMemoryRelativePath,
  sharedMemoryScopeKey,
  isValidSharedMemoryId,
  type SharedMemory,
  type SharedMemoryFile,
  type SharedMemoryScope,
} from "../domain/shared-memory";
import type { SharedMemoryStore } from "../ports/shared-memory-store";

const MEMORY_FILE_NAME = "MEMORY.md";

export const SHARED_MEMORY_FILE_HEADER = `# MEMORY.md

<!-- Your curated long-term memory: durable facts, preferences, and commitments. Keep it tight: promote what lasts here, and leave raw day-to-day detail in your daily notes. -->`;

export class MarkdownSharedMemoryStore implements SharedMemoryStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async read(guildId: string, scope: SharedMemoryScope): Promise<SharedMemory> {
    const filePath = this.filePath(guildId, scope);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return emptySharedMemory();
      throw new Error(`Failed to read shared memory file: ${filePath}`, { cause: error });
    }

    return parseSharedMemory(content);
  }

  async write(guildId: string, scope: SharedMemoryScope, memory: SharedMemory): Promise<void> {
    if (memory.facts.length === 0 && memory.preferences.length === 0) {
      await this.delete(guildId, scope);
      return;
    }

    await this.writeContent(guildId, scope, renderSharedMemory(memory));
  }

  async writeContent(guildId: string, scope: SharedMemoryScope, content: string): Promise<void> {
    if (content.trim().length === 0) {
      await this.delete(guildId, scope);
      return;
    }

    const filePath = this.filePath(guildId, scope);
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async delete(guildId: string, scope: SharedMemoryScope): Promise<void> {
    const filePath = this.filePath(guildId, scope);
    await unlink(filePath).catch((error: unknown) => {
      if (!isFileNotFound(error)) throw error;
    });
  }

  async listFiles(guildId: string): Promise<readonly SharedMemoryFile[]> {
    assertSharedMemoryId(guildId, "guild");
    const guildDirectory = join(this.directory, guildId);
    const files: SharedMemoryFile[] = [];

    const guildFile = await readSharedMemoryFile(guildDirectory, { type: "guild" });
    if (guildFile) files.push(guildFile);

    let entries;
    try {
      entries = await readdir(guildDirectory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return files;
      throw new Error(`Failed to list shared memory directory: ${guildDirectory}`, {
        cause: error,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSharedMemoryId(entry.name)) continue;
      const channelDirectory = join(guildDirectory, entry.name);
      const channelFile = await readSharedMemoryFile(channelDirectory, {
        channelId: entry.name,
        type: "channel",
      });
      if (channelFile) files.push(channelFile);

      let threadEntries;
      try {
        threadEntries = await readdir(channelDirectory, { withFileTypes: true });
      } catch (error) {
        if (isFileNotFound(error)) continue;
        throw new Error(`Failed to list thread memory directory: ${channelDirectory}`, {
          cause: error,
        });
      }

      for (const threadEntry of threadEntries) {
        if (!threadEntry.isDirectory() || !isValidSharedMemoryId(threadEntry.name)) continue;
        const threadFile = await readSharedMemoryFile(join(channelDirectory, threadEntry.name), {
          channelId: entry.name,
          threadId: threadEntry.name,
          type: "thread",
        });
        if (threadFile) files.push(threadFile);
      }
    }

    return files.toSorted((left, right) => {
      const rankDifference = scopeRank(left.scope) - scopeRank(right.scope);
      if (rankDifference !== 0) return rankDifference;
      return sharedMemoryScopeKey(left.scope).localeCompare(sharedMemoryScopeKey(right.scope));
    });
  }

  async listGuildIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new Error(`Failed to list shared memory directory: ${this.directory}`, {
        cause: error,
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && isValidSharedMemoryId(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));
  }

  private filePath(guildId: string, scope: SharedMemoryScope): string {
    assertSharedMemoryId(guildId, "guild");
    switch (scope.type) {
      case "guild":
        return join(this.directory, guildId, sharedMemoryRelativePath(scope));
      case "channel":
        assertSharedMemoryId(scope.channelId, "channel");
        return join(this.directory, guildId, sharedMemoryRelativePath(scope));
      case "thread":
        assertSharedMemoryId(scope.channelId, "channel");
        assertSharedMemoryId(scope.threadId, "thread");
        return join(this.directory, guildId, sharedMemoryRelativePath(scope));
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unsupported shared memory scope: ${String(exhaustive)}`);
      }
    }
  }
}

export function parseSharedMemory(content: string): SharedMemory {
  const facts: string[] = [];
  const preferences: string[] = [];
  let section: "facts" | "preferences" | undefined;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const title = heading[2]?.trim().toLocaleLowerCase("en-US");
      if (title === "facts") section = "facts";
      else if (title === "preferences") section = "preferences";
      else section = undefined;
      continue;
    }

    if (!section) {
      if (!/^[-*+]\s+/u.test(line)) continue;
      facts.push(line.replace(/^[-*+]\s+/u, "").trim());
      continue;
    }

    const item = line.replace(/^[-*+]\s+/u, "").trim();
    if (!item) continue;
    (section === "facts" ? facts : preferences).push(item);
  }

  return { facts: unique(facts), preferences: unique(preferences) };
}

export function renderSharedMemory(memory: SharedMemory): string {
  return `${[
    SHARED_MEMORY_FILE_HEADER,
    renderSection("Facts", memory.facts),
    renderSection("Preferences", memory.preferences),
  ].join("\n\n")}\n`;
}

async function readSharedMemoryFile(
  directory: string,
  scope: SharedMemoryScope,
): Promise<SharedMemoryFile | undefined> {
  const filePath = join(directory, MEMORY_FILE_NAME);
  let content: string;
  let mtime: Date;
  try {
    const [fileContent, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    content = fileContent;
    mtime = fileStat.mtime;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new Error(`Failed to read shared memory file: ${filePath}`, { cause: error });
  }

  const memory = parseSharedMemory(content);
  if (memory.facts.length === 0 && memory.preferences.length === 0) return undefined;
  return { ...memory, content, scope, updatedAt: mtime.toISOString() };
}

function scopeRank(scope: SharedMemoryScope): number {
  switch (scope.type) {
    case "guild":
      return 0;
    case "channel":
      return 1;
    case "thread":
      return 2;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported shared memory scope: ${String(exhaustive)}`);
    }
  }
}

function renderSection(title: string, items: readonly string[]): string {
  return [`## ${title}`, ...(items.length > 0 ? [renderBullets(items)] : [])].join("\n\n");
}

function renderBullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function emptySharedMemory(): SharedMemory {
  return { facts: [], preferences: [] };
}

function assertSharedMemoryId(value: string, kind: string): void {
  if (!isValidSharedMemoryId(value)) {
    throw new Error(`Invalid shared memory ${kind} id: ${value}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
