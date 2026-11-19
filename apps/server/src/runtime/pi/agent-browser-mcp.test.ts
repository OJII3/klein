import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRole } from "@agents/core/agent-role";
import { createAgentBrowserMcpConfig, enablesAgentBrowser } from "./agent-browser-mcp";

test("registers agent-browser with the core MCP tools", () => {
  const config = createAgentBrowserMcpConfig("attached-1");

  assert.equal(config.command, "agent-browser");
  assert.deepEqual(config.args, ["mcp", "--tools", "core"]);
  assert.equal(config.exposure, "deferred");
});

test("names the browser session after the worker task", () => {
  assert.equal(createAgentBrowserMcpConfig("attached-1").env.AGENT_BROWSER_SESSION, "attached-1");
  assert.equal(createAgentBrowserMcpConfig("attached-2").env.AGENT_BROWSER_SESSION, "attached-2");
});

test("bounds page output and lets the daemon exit after a pause", () => {
  const config = createAgentBrowserMcpConfig("attached-1");

  assert.ok(Number(config.env.AGENT_BROWSER_MAX_OUTPUT) > 0);
  assert.ok(Number(config.env.AGENT_BROWSER_IDLE_TIMEOUT_MS) > 0);
  assert.equal(config.env.AGENT_BROWSER_CONTENT_BOUNDARIES, "1");
});

test("enables the browser only for owner-feature attached tasks", () => {
  const attached: AgentRole = { kind: "attached", taskId: "attached-1" };
  const conversation: AgentRole = { kind: "conversation" };
  const standalone: AgentRole = { kind: "standalone" };

  assert.equal(enablesAgentBrowser(attached, true), true);
  assert.equal(enablesAgentBrowser(attached, false), false);
  assert.equal(enablesAgentBrowser(attached, undefined), false);
  assert.equal(enablesAgentBrowser(conversation, true), false);
  assert.equal(enablesAgentBrowser(standalone, true), false);
});
