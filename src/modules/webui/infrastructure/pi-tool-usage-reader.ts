import { open, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { McpServerUsageStat, ToolUsageReport, ToolUsageStat } from "../domain/viewer-event";
import type { ToolUsageReader } from "../ports/viewer-readers";

interface ToolCounter {
  calls: number;
  errors: number;
  lastCalledAt: number | undefined;
}

interface CachedSessionFile {
  size: number;
  mtimeMs: number;
  offset: number;
  remainder: string;
  counters: Map<string, ToolCounter>;
}

interface McpServerCounter {
  calls: number;
  errors: number;
  toolNames: Set<string>;
  lastCalledAt: number | undefined;
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * Aggregates tool executions from Pi session files. Each session is append-only, so every file is
 * parsed once and then only the newly appended bytes are read on later requests.
 */
export class PiToolUsageReader implements ToolUsageReader {
  private readonly cache = new Map<string, CachedSessionFile>();

  constructor(private readonly agentDirectory: string) {}

  async read(): Promise<ToolUsageReport> {
    const sessionFiles = await this.listSessionFiles();
    const seen = new Set(sessionFiles);

    for (const filePath of sessionFiles) {
      try {
        await this.ingest(filePath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }

    for (const filePath of this.cache.keys()) {
      if (!seen.has(filePath)) this.cache.delete(filePath);
    }

    return this.buildReport(sessionFiles.length);
  }

  private async listSessionFiles(): Promise<string[]> {
    const sessionsDirectory = resolve(this.agentDirectory, "sessions");

    let entries;
    try {
      entries = await readdir(sessionsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directory = resolve(sessionsDirectory, entry.name);
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }

      for (const child of children) {
        if (child.isFile() && child.name.endsWith(".jsonl")) {
          files.push(resolve(directory, child.name));
        }
      }
    }

    return files.sort();
  }

  private async ingest(filePath: string): Promise<void> {
    const stats = await stat(filePath);
    let cached = this.cache.get(filePath);

    const rewritten =
      cached !== undefined &&
      (stats.size < cached.offset ||
        (stats.size === cached.size && stats.mtimeMs !== cached.mtimeMs));
    if (!cached || rewritten) {
      cached = {
        offset: 0,
        remainder: "",
        counters: new Map(),
        mtimeMs: 0,
        size: 0,
      };
    }

    if (stats.size === cached.size && stats.mtimeMs === cached.mtimeMs) {
      this.cache.set(filePath, cached);
      return;
    }

    const length = stats.size - cached.offset;
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, cached.offset));
    } finally {
      await handle.close();
    }

    const chunk = cached.remainder + buffer.subarray(0, bytesRead).toString("utf8");
    const lines = chunk.split("\n");
    cached.remainder = lines.pop() ?? "";
    for (const line of lines) countToolResult(line, cached.counters);

    cached.offset += bytesRead;
    cached.mtimeMs = stats.mtimeMs;
    cached.size = cached.offset;
    this.cache.set(filePath, cached);
  }

  private buildReport(sessionCount: number): ToolUsageReport {
    const tools = new Map<string, ToolCounter>();
    for (const file of this.cache.values()) {
      for (const [name, counter] of file.counters) {
        mergeCounter(tools, name, counter);
      }
    }

    const mcpServers = new Map<string, McpServerCounter>();
    for (const [name, counter] of tools) {
      const serverName = MCP_TOOL_NAME.exec(name)?.[1];
      if (!serverName) continue;

      const server = mcpServers.get(serverName) ?? {
        calls: 0,
        errors: 0,
        lastCalledAt: undefined,
        toolNames: new Set<string>(),
      };
      server.calls += counter.calls;
      server.errors += counter.errors;
      server.toolNames.add(name);
      server.lastCalledAt = latestTimestamp(server.lastCalledAt, counter.lastCalledAt);
      mcpServers.set(serverName, server);
    }

    const toolStats: ToolUsageStat[] = [...tools.entries()]
      .map(([name, counter]) => ({
        calls: counter.calls,
        errors: counter.errors,
        lastCalledAt: formatTimestamp(counter.lastCalledAt),
        name,
      }))
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));

    const serverStats: McpServerUsageStat[] = [...mcpServers.entries()]
      .map(([name, counter]) => ({
        calls: counter.calls,
        errors: counter.errors,
        lastCalledAt: formatTimestamp(counter.lastCalledAt),
        name,
        toolCount: counter.toolNames.size,
      }))
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));

    return {
      mcpServers: serverStats,
      sessionCount,
      tools: toolStats,
      totalCalls: toolStats.reduce((sum, tool) => sum + tool.calls, 0),
      totalErrors: toolStats.reduce((sum, tool) => sum + tool.errors, 0),
    };
  }
}

function countToolResult(line: string, counters: Map<string, ToolCounter>): void {
  if (!line.includes('"toolResult"')) return;

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return;
  const message = entry.message;
  if (message.role !== "toolResult" || typeof message.toolName !== "string") return;
  if (message.toolName.length === 0) return;

  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  const at = Number.isNaN(timestamp) ? undefined : timestamp;
  recordCall(counters, message.toolName, message.isError === true, at);

  // Codemode and other tools can invoke further tools without producing model-visible results.
  if (isRecord(message.nestedCalls) && Array.isArray(message.nestedCalls.calls)) {
    for (const call of message.nestedCalls.calls) {
      if (!isRecord(call) || typeof call.name !== "string" || call.name.length === 0) continue;
      recordCall(counters, call.name, call.status === "error", at);
    }
  }
}

function recordCall(
  counters: Map<string, ToolCounter>,
  name: string,
  isError: boolean,
  timestamp: number | undefined,
): void {
  const counter = counters.get(name) ?? {
    calls: 0,
    errors: 0,
    lastCalledAt: undefined,
  };
  counter.calls += 1;
  if (isError) counter.errors += 1;
  counter.lastCalledAt = latestTimestamp(counter.lastCalledAt, timestamp);
  counters.set(name, counter);
}

function mergeCounter(targets: Map<string, ToolCounter>, name: string, counter: ToolCounter): void {
  const target = targets.get(name) ?? {
    calls: 0,
    errors: 0,
    lastCalledAt: undefined,
  };
  target.calls += counter.calls;
  target.errors += counter.errors;
  target.lastCalledAt = latestTimestamp(target.lastCalledAt, counter.lastCalledAt);
  targets.set(name, target);
}

function latestTimestamp(
  current: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (candidate === undefined) return current;
  return current === undefined || candidate > current ? candidate : current;
}

function formatTimestamp(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
