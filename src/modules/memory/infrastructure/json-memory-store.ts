import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve, sep } from "node:path";

import {
  MEMORY_KINDS,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryKind,
  type MemoryOperation,
  type MemoryStore,
} from "../domain/memory";

const MEMORY_GUILD_ID_TOKEN = "{guildId}";

export class JsonMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(): Promise<MemoryDocument> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { entries: [] };
      throw new Error(`Failed to read memory file: ${this.filePath}`, { cause: error });
    }

    return parseMemoryDocument(content);
  }

  async apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<void> {
    const effectiveOperations = operations.filter((operation) => operation.type !== "noop");
    if (effectiveOperations.length === 0) return;

    const document = await this.read();
    const entries = [...document.entries];
    const now = new Date().toISOString();
    const sourceIds = unique(sourceMessageIds);

    for (const operation of effectiveOperations) {
      if (operation.type === "add") {
        entries.push({
          content: operation.content,
          createdAt: now,
          id: `mem_${randomUUID()}`,
          kind: operation.kind,
          sourceMessageIds: sourceIds,
          title: operation.title,
          updatedAt: now,
        });
        continue;
      }

      const index = entries.findIndex((entry) => entry.id === operation.id);
      if (index === -1) {
        throw new Error(`Memory entry was not found: ${operation.id}`);
      }

      if (operation.type === "delete") {
        entries.splice(index, 1);
        continue;
      }

      const previous = entries[index];
      if (!previous) throw new Error(`Memory entry was not found: ${operation.id}`);
      entries[index] = {
        content: operation.content,
        createdAt: previous.createdAt,
        id: previous.id,
        kind: operation.kind,
        sourceMessageIds: unique([...previous.sourceMessageIds, ...sourceIds]),
        title: operation.title,
        updatedAt: now,
      };
    }

    await this.write({ entries });
  }

  private async write(document: MemoryDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, renderMemoryDocument(document), "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export function parseMemoryDocument(content: string): MemoryDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Memory file contains invalid JSON", { cause: error });
  }

  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Memory file contains an invalid document");
  }

  const entries = value.entries.map(parseMemoryEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id))
      throw new Error(`Memory file contains a duplicate memory id: ${entry.id}`);
    ids.add(entry.id);
  }

  return { entries };
}

export async function listMemoryGuildIds(filePath: string): Promise<string[]> {
  const guildIds = await listGuildIdsForPath(filePath);
  return guildIds.sort((left, right) => left.localeCompare(right));
}

export function renderMemoryDocument(document: MemoryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function listGuildIdsForPath(filePath: string): Promise<string[]> {
  const absolutePath = resolve(filePath);
  const tokenIndex = absolutePath.indexOf(MEMORY_GUILD_ID_TOKEN);
  if (tokenIndex === -1) return [];

  const prefix = absolutePath.slice(0, tokenIndex);
  const suffix = absolutePath.slice(tokenIndex + MEMORY_GUILD_ID_TOKEN.length);
  const hasDirectoryPrefix = prefix.endsWith(sep);
  const directory = hasDirectoryPrefix ? prefix.slice(0, -1) || sep : dirname(prefix);
  const namePrefix = hasDirectoryPrefix ? "" : basename(prefix);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const guildIds: string[] = [];
  for (const entry of entries) {
    if (!hasDirectoryPrefix && !entry.name.startsWith(namePrefix)) continue;
    if (hasDirectoryPrefix && !entry.isDirectory()) continue;
    if (!hasDirectoryPrefix && suffix && !entry.name.endsWith(suffix)) continue;

    const guildId = hasDirectoryPrefix
      ? entry.name
      : entry.name.slice(namePrefix.length, entry.name.length - suffix.length);
    if (!guildId || guildId.includes("/") || guildId.includes("\\")) continue;

    const candidate = hasDirectoryPrefix
      ? resolve(directory, entry.name) + suffix
      : resolve(directory, entry.name);

    try {
      if ((await stat(candidate)).isFile()) guildIds.push(guildId);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  return guildIds;
}

function parseMemoryEntry(value: unknown): MemoryEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isMemoryKind(value.kind) ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.sourceMessageIds) ||
    !value.sourceMessageIds.every((id) => typeof id === "string")
  ) {
    throw new Error("Memory file contains a malformed memory entry");
  }

  return {
    content: value.content,
    createdAt: value.createdAt,
    id: value.id,
    kind: value.kind,
    sourceMessageIds: value.sourceMessageIds,
    title: value.title,
    updatedAt: value.updatedAt,
  };
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KINDS.includes(value as MemoryKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
