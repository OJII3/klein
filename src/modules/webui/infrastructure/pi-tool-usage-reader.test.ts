import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPiSessionManager } from "@runtime/pi/pi-agent-runtime";
import { PiToolUsageReader } from "./pi-tool-usage-reader";

test("aggregates tool calls and MCP servers from Pi sessions", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-tool-usage-"));

  try {
    const sessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:123",
      "new",
      process.cwd(),
    );
    appendUserMessage(sessionManager);
    appendToolResult(sessionManager, "discord_send", false);
    appendToolResult(sessionManager, "discord_send", false);
    appendToolResult(sessionManager, "mcp__docs__read_note", true);
    appendNestedToolResult(sessionManager, "codemode", [
      { name: "mcp__docs__read_note", status: "ok" },
    ]);

    const secondSessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:456",
      "new",
      process.cwd(),
    );
    appendUserMessage(secondSessionManager);
    appendToolResult(secondSessionManager, "mcp__docs__search", false);

    const reader = new PiToolUsageReader(agentDirectory);
    const first = await reader.read();

    assert.equal(first.sessionCount, 2);
    assert.equal(first.totalCalls, 6);
    assert.equal(first.totalErrors, 1);
    assert.deepEqual(
      first.tools.map((tool) => [tool.name, tool.calls, tool.errors]),
      [
        ["discord_send", 2, 0],
        ["mcp__docs__read_note", 2, 1],
        ["codemode", 1, 0],
        ["mcp__docs__search", 1, 0],
      ],
    );
    assert.deepEqual(
      first.mcpServers.map((server) => [
        server.name,
        server.calls,
        server.errors,
        server.toolCount,
      ]),
      [["docs", 3, 1, 2]],
    );

    appendToolResult(sessionManager, "mcp__docs__read_note", false);
    const second = await reader.read();

    assert.equal(second.totalCalls, 7);
    assert.equal(second.totalErrors, 1);
    const readNote = second.tools.find((tool) => tool.name === "mcp__docs__read_note");
    assert.equal(readNote?.calls, 3);
    assert.equal(readNote?.errors, 1);
    assert.equal(second.mcpServers[0]?.calls, 4);
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("reads appends split across partial lines without duplicating them", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-tool-usage-partial-"));

  try {
    const sessionDirectory = join(
      agentDirectory,
      "sessions",
      encodeURIComponent("discord-channel:1"),
    );
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    const first = toolResultLine("first_tool");
    const second = toolResultLine("second_tool");

    await writeFile(sessionFile, first);
    const reader = new PiToolUsageReader(agentDirectory);
    assert.equal((await reader.read()).totalCalls, 0);

    await appendFile(sessionFile, `\n${second}\n`);
    const report = await reader.read();
    assert.equal(report.totalCalls, 2);
    assert.deepEqual(
      report.tools.map((tool) => [tool.name, tool.calls]),
      [
        ["first_tool", 1],
        ["second_tool", 1],
      ],
    );
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("returns an empty report when there are no sessions", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-tool-usage-empty-"));

  try {
    const report = await new PiToolUsageReader(agentDirectory).read();
    assert.deepEqual(report, {
      mcpServers: [],
      sessionCount: 0,
      tools: [],
      totalCalls: 0,
      totalErrors: 0,
    });
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

function toolResultLine(toolName: string): string {
  return JSON.stringify({
    id: `entry-${toolName}`,
    message: {
      content: [],
      isError: false,
      role: "toolResult",
      timestamp: Date.now(),
      toolCallId: `call-${toolName}`,
      toolName,
    },
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
  });
}

function appendUserMessage(sessionManager: ReturnType<typeof createPiSessionManager>): void {
  sessionManager.appendMessage({ content: "hello", role: "user", timestamp: Date.now() } as never);
}

function appendToolResult(
  sessionManager: ReturnType<typeof createPiSessionManager>,
  toolName: string,
  isError: boolean,
): void {
  sessionManager.appendMessage({
    content: [],
    isError,
    role: "toolResult",
    timestamp: Date.now(),
    toolCallId: "call-1",
    toolName,
  } as never);
}

function appendNestedToolResult(
  sessionManager: ReturnType<typeof createPiSessionManager>,
  toolName: string,
  calls: { name: string; status: "ok" | "error" | "unfinished" }[],
): void {
  sessionManager.appendMessage({
    content: [],
    isError: false,
    nestedCalls: { calls, complete: true },
    role: "toolResult",
    timestamp: Date.now(),
    toolCallId: "call-2",
    toolName,
  } as never);
}
