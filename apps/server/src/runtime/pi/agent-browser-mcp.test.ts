import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRole } from "@agents/core/agent-role";
import {
  browserProfileKey,
  createAgentBrowserMcpConfig,
  createAgentBrowserProfileDirectory,
  enablesAgentBrowser,
} from "./agent-browser-mcp";

test("registers agent-browser with the core MCP tools", () => {
  const config = createAgentBrowserMcpConfig("123", "/tmp/profiles/123");

  assert.equal(config.command, "agent-browser");
  assert.deepEqual(config.args, ["mcp", "--tools", "core"]);
  assert.equal(config.exposure, "deferred");
});

test("names the browser session and profile after the linked user", () => {
  const config = createAgentBrowserMcpConfig("123", "/tmp/profiles/123");

  assert.equal(config.env.AGENT_BROWSER_SESSION, "discord-user-123");
  assert.equal(config.env.AGENT_BROWSER_PROFILE, "/tmp/profiles/123");
  assert.equal(config.env.AGENT_BROWSER_NAMESPACE, "klein");
  assert.equal(
    createAgentBrowserMcpConfig("456", "/tmp/profiles/456").env.AGENT_BROWSER_SESSION,
    "discord-user-456",
  );
});

test("sanitizes user ids for session names and profile directories", () => {
  assert.equal(browserProfileKey("123"), "123");
  assert.equal(browserProfileKey("user/../456"), "user____456");
  assert.equal(
    createAgentBrowserProfileDirectory("/tmp/agent", "123"),
    "/tmp/agent/browser-profiles/123",
  );
});

test("bounds page output and lets the daemon exit after a pause", () => {
  const config = createAgentBrowserMcpConfig("123", "/tmp/profiles/123");

  assert.ok(Number(config.env.AGENT_BROWSER_MAX_OUTPUT) > 0);
  assert.ok(Number(config.env.AGENT_BROWSER_IDLE_TIMEOUT_MS) > 0);
  assert.equal(config.env.AGENT_BROWSER_CONTENT_BOUNDARIES, "1");
});

test("enables the browser only for workers with a linked user", () => {
  const worker: AgentRole = { kind: "worker", workerId: "worker-1" };
  const conversation: AgentRole = { kind: "conversation" };
  const standalone: AgentRole = { kind: "standalone" };

  assert.equal(enablesAgentBrowser(worker, "123"), true);
  assert.equal(enablesAgentBrowser(worker, undefined), false);
  assert.equal(enablesAgentBrowser(conversation, "123"), false);
  assert.equal(enablesAgentBrowser(standalone, "123"), false);
});
