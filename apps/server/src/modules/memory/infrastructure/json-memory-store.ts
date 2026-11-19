import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";

import {
  MEMORY_KINDS,
  type MemoryApplyResult,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryEntryScope,
  type MemoryKind,
  type MemoryOperation,
} from "../domain/memory";
import type { MemoryStore } from "../ports/memory-store";

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
      if (isFileNotFound(error)) return { entries: [] };
      throw new Error(`Failed to read memory file: ${this.filePath}`, { cause: error });
    }

    return parseMemoryDocument(content);
  }

  async apply(
    operations: readonly MemoryOperation[],
    sourceMessageIds: readonly string[],
  ): Promise<MemoryApplyResult> {
    const effectiveOperations = operations.filter((operation) => operation.type !== "noop");
    if (effectiveOperations.length === 0) return emptyApplyResult();

    const document = await this.read();
    const entries = [...document.entries];
    const now = new Date().toISOString();
    const sourceIds = unique(sourceMessageIds);
    const result: { created: MemoryEntry[]; updated: MemoryEntry[]; deleted: MemoryEntry[] } = {
      created: [],
      updated: [],
      deleted: [],
    };

    for (const operation of effectiveOperations) {
      if (operation.type === "add") {
        const entry: MemoryEntry = {
          content: operation.content,
          createdAt: now,
          id: `mem_${randomUUID()}`,
          kind: operation.kind,
          scope: operation.scope,
          sourceMessageIds: sourceIds,
          title: operation.title,
          updatedAt: now,
        };
        entries.push(entry);
        result.created.push(entry);
        continue;
      }

      const index = entries.findIndex((entry) => entry.id === operation.id);
      if (index === -1) {
        throw new Error(`Memory entry was not found: ${operation.id}`);
      }

      if (operation.type === "delete") {
        const [deleted] = entries.splice(index, 1);
        if (deleted) result.deleted.push(deleted);
        continue;
      }

      const previous = entries[index];
      if (!previous) throw new Error(`Memory entry was not found: ${operation.id}`);
      const updated: MemoryEntry = {
        content: operation.content,
        createdAt: previous.createdAt,
        id: previous.id,
        kind: operation.kind,
        scope: operation.scope,
        sourceMessageIds: unique([...previous.sourceMessageIds, ...sourceIds]),
        title: operation.title,
        updatedAt: now,
      };
      entries[index] = updated;
      result.updated.push(updated);
    }

    await this.write({ entries });
    return result;
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

function emptyApplyResult(): MemoryApplyResult {
  return { created: [], updated: [], deleted: [] };
}

export function parseMemoryDocument(content: string): MemoryDocument {
  let value: unknown;
  try {
    value = parseJson(content);
  } catch (error) {
    throw new Error("Memory file contains invalid JSON", { cause: error });
  }

  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Memory file contains an invalid document");
  }

  const entries = value.entries.map((entry) => parseMemoryEntry(entry));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id))
      throw new Error(`Memory file contains a duplicate memory id: ${entry.id}`);
    ids.add(entry.id);
  }

  return { entries };
}

export function renderMemoryDocument(document: MemoryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseMemoryEntry(value: unknown): MemoryEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isMemoryKind(value.kind) ||
    !isMemoryEntryScope(value.scope) ||
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
    scope: parseMemoryEntryScope(value.scope),
    sourceMessageIds: value.sourceMessageIds,
    title: value.title,
    updatedAt: value.updatedAt,
  };
}

function isMemoryEntryScope(value: unknown): value is MemoryEntryScope {
  if (!isRecord(value)) return false;
  if (value.type === "owner" || value.type === "guild") return true;
  if (value.type === "channel") {
    return typeof value.channelId === "string" && value.channelId.length > 0;
  }
  if (value.type === "thread") {
    return (
      typeof value.channelId === "string" &&
      value.channelId.length > 0 &&
      typeof value.threadId === "string" &&
      value.threadId.length > 0
    );
  }
  return false;
}

function parseMemoryEntryScope(value: MemoryEntryScope): MemoryEntryScope {
  if (value.type === "channel") return { channelId: value.channelId, type: "channel" };
  if (value.type === "thread") {
    return { channelId: value.channelId, threadId: value.threadId, type: "thread" };
  }
  return { type: value.type };
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KINDS.some((kind) => kind === value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
