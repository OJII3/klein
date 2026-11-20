import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { AgentRole } from "@agents/core/agent-role";
import { resolveUserEnvironment } from "@shared/user-environment";
import { createTempDir } from "../../testing/temp-dir";
import {
  agentBrowserProfileDirectory,
  createAgentBrowserMcpConfig,
  enablesAgentBrowser,
  migrateLegacyAgentBrowserProfile,
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

test("keeps the profile inside the user's credentials", () => {
  const environment = resolveUserEnvironment("/tmp/agent", "123");

  assert.equal(
    agentBrowserProfileDirectory(environment),
    "/tmp/agent/users/123/credentials/browser",
  );
  assert.equal(
    createAgentBrowserMcpConfig("user/../456", "/tmp/profile").env.AGENT_BROWSER_SESSION,
    "discord-user-user____456",
  );
});

test("moves a browser profile written before per-user environments", async () => {
  await using temp = await createTempDir("klein-browser-profile-");
  const environment = resolveUserEnvironment(temp.path, "123");
  const legacyDirectory = join(temp.path, "browser-profiles", "123");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "Cookies"), "session");

  const profileDirectory = migrateLegacyAgentBrowserProfile(temp.path, environment);

  assert.equal(profileDirectory, agentBrowserProfileDirectory(environment));
  assert.equal(readFileSync(join(profileDirectory, "Cookies"), "utf8"), "session");
  assert.equal(existsSync(legacyDirectory), false);
});

test("keeps a migrated profile instead of the legacy directory", async () => {
  await using temp = await createTempDir("klein-browser-profile-");
  const environment = resolveUserEnvironment(temp.path, "123");
  const profileDirectory = agentBrowserProfileDirectory(environment);
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(join(profileDirectory, "Cookies"), "current");

  migrateLegacyAgentBrowserProfile(temp.path, environment);

  assert.equal(readFileSync(join(profileDirectory, "Cookies"), "utf8"), "current");
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
