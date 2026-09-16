import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  MEMORY_KINDS,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryKind,
  type MemoryOperation,
  type MemoryStore,
} from "../domain/memory";

const MEMORY_FILE_HEADER = `# Guild Memory

Klein がギルド内の複数チャンネルで共有するメモリです。
`;
const MEMORY_BLOCK_PATTERN =
  /<!-- memory:start\n([\s\S]*?)\n-->\n([\s\S]*?)\n<!-- memory:end -->/gu;

export class MarkdownMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(): Promise<MemoryDocument> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { entries: [] };
      }

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
  const entries: MemoryEntry[] = [];
  const blockStarts = content.match(/<!-- memory:start\n/gu)?.length ?? 0;
  const blockEnds = content.match(/\n<!-- memory:end -->/gu)?.length ?? 0;

  if (blockStarts !== blockEnds) {
    throw new Error("Memory file contains an unclosed memory entry");
  }

  for (const match of content.matchAll(MEMORY_BLOCK_PATTERN)) {
    const metadata = parseMetadata(match[1] ?? "");
    const body = (match[2] ?? "").trim();
    const titleLine = body.split(/\r?\n/u)[0] ?? "";
    const title = titleLine.startsWith("### ") ? titleLine.slice(4).trim() : "";
    const entryContent = body.slice(titleLine.length).trim();

    if (
      !metadata.id ||
      !isMemoryKind(metadata.kind) ||
      !title ||
      !entryContent ||
      !metadata.created_at ||
      !metadata.updated_at
    ) {
      throw new Error("Memory file contains a malformed memory entry");
    }

    if (entries.some((entry) => entry.id === metadata.id)) {
      throw new Error(`Memory file contains a duplicate memory id: ${metadata.id}`);
    }

    entries.push({
      content: entryContent,
      createdAt: metadata.created_at,
      id: metadata.id,
      kind: metadata.kind,
      sourceMessageIds: metadata.source_message_ids
        ? metadata.source_message_ids.split(",").filter(Boolean)
        : [],
      title,
      updatedAt: metadata.updated_at,
    });
  }

  return { entries };
}

export function renderMemoryDocument(document: MemoryDocument): string {
  const blocks = document.entries.map(
    (entry) => `<!-- memory:start
id: ${entry.id}
kind: ${entry.kind}
created_at: ${entry.createdAt}
updated_at: ${entry.updatedAt}
source_message_ids: ${entry.sourceMessageIds.join(",")}
-->
### ${entry.title}

${entry.content}
<!-- memory:end -->`,
  );

  return `${MEMORY_FILE_HEADER}${blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : ""}`;
}

function parseMetadata(metadata: string): Record<string, string> {
  return Object.fromEntries(
    metadata
      .split(/\r?\n/u)
      .map((line) => line.match(/^([a-z_]+):\s*(.*)$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1]!, match[2] ?? ""]),
  );
}

function isMemoryKind(value: string | undefined): value is MemoryKind {
  return value !== undefined && MEMORY_KINDS.includes(value as MemoryKind);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
