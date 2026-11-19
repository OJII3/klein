import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isFileNotFound } from "@shared/type-guards";

import {
  guildMemoryScopeKey,
  isValidGuildMemoryId,
  type GuildMemory,
  type GuildMemoryFile,
  type GuildMemoryScope,
} from "../domain/guild-memory";
import type { GuildMemoryStore } from "../ports/guild-memory-store";

const MEMORY_FILE_NAME = "MEMORY.md";

export const GUILD_MEMORY_FILE_HEADER = `# MEMORY.md

<!-- Your curated long-term memory: durable facts, preferences, and commitments. Keep it tight: promote what lasts here, and leave raw day-to-day detail in your daily notes. -->`;

export class MarkdownGuildMemoryStore implements GuildMemoryStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async read(guildId: string, scope: GuildMemoryScope): Promise<GuildMemory> {
    const filePath = this.filePath(guildId, scope);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return emptyGuildMemory();
      throw new Error(`Failed to read guild memory file: ${filePath}`, { cause: error });
    }

    return parseGuildMemory(content);
  }

  async write(guildId: string, scope: GuildMemoryScope, memory: GuildMemory): Promise<void> {
    const filePath = this.filePath(guildId, scope);
    if (memory.facts.length === 0 && memory.preferences.length === 0) {
      await unlink(filePath).catch((error: unknown) => {
        if (!isFileNotFound(error)) throw error;
      });
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, renderGuildMemory(memory), "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async listFiles(guildId: string): Promise<readonly GuildMemoryFile[]> {
    assertGuildMemoryId(guildId, "guild");
    const guildDirectory = join(this.directory, guildId);
    const files: GuildMemoryFile[] = [];

    const guildFile = await readGuildMemoryFile(guildDirectory, { type: "guild" });
    if (guildFile) files.push(guildFile);

    let entries;
    try {
      entries = await readdir(guildDirectory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return files;
      throw new Error(`Failed to list guild memory directory: ${guildDirectory}`, { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidGuildMemoryId(entry.name)) continue;
      const channelDirectory = join(guildDirectory, entry.name);
      const channelFile = await readGuildMemoryFile(channelDirectory, {
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
        if (!threadEntry.isDirectory() || !isValidGuildMemoryId(threadEntry.name)) continue;
        const threadFile = await readGuildMemoryFile(join(channelDirectory, threadEntry.name), {
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
      return guildMemoryScopeKey(left.scope).localeCompare(guildMemoryScopeKey(right.scope));
    });
  }

  async listGuildIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new Error(`Failed to list guild memory directory: ${this.directory}`, { cause: error });
    }

    return entries
      .filter((entry) => entry.isDirectory() && isValidGuildMemoryId(entry.name))
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));
  }

  private filePath(guildId: string, scope: GuildMemoryScope): string {
    assertGuildMemoryId(guildId, "guild");
    switch (scope.type) {
      case "guild":
        return join(this.directory, guildId, MEMORY_FILE_NAME);
      case "channel":
        assertGuildMemoryId(scope.channelId, "channel");
        return join(this.directory, guildId, scope.channelId, MEMORY_FILE_NAME);
      case "thread":
        assertGuildMemoryId(scope.channelId, "channel");
        assertGuildMemoryId(scope.threadId, "thread");
        return join(this.directory, guildId, scope.channelId, scope.threadId, MEMORY_FILE_NAME);
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unsupported guild memory scope: ${String(exhaustive)}`);
      }
    }
  }
}

export function parseGuildMemory(content: string): GuildMemory {
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

export function renderGuildMemory(memory: GuildMemory): string {
  return `${[
    GUILD_MEMORY_FILE_HEADER,
    renderSection("Facts", memory.facts),
    renderSection("Preferences", memory.preferences),
  ].join("\n\n")}\n`;
}

async function readGuildMemoryFile(
  directory: string,
  scope: GuildMemoryScope,
): Promise<GuildMemoryFile | undefined> {
  const filePath = join(directory, MEMORY_FILE_NAME);
  let content: string;
  let mtime: Date;
  try {
    const [fileContent, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    content = fileContent;
    mtime = fileStat.mtime;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new Error(`Failed to read guild memory file: ${filePath}`, { cause: error });
  }

  const memory = parseGuildMemory(content);
  if (memory.facts.length === 0 && memory.preferences.length === 0) return undefined;
  return { ...memory, scope, updatedAt: mtime.toISOString() };
}

function scopeRank(scope: GuildMemoryScope): number {
  switch (scope.type) {
    case "guild":
      return 0;
    case "channel":
      return 1;
    case "thread":
      return 2;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported guild memory scope: ${String(exhaustive)}`);
    }
  }
}

function renderSection(title: string, items: readonly string[]): string {
  return [`## ${title}`, ...(items.length > 0 ? [renderBullets(items)] : [])].join("\n\n");
}

function renderBullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function emptyGuildMemory(): GuildMemory {
  return { facts: [], preferences: [] };
}

function assertGuildMemoryId(value: string, kind: string): void {
  if (!isValidGuildMemoryId(value)) {
    throw new Error(`Invalid guild memory ${kind} id: ${value}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
