import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionFactory, McpServerConfig } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "@agents/core/agent-role";

/** Server tools are named `mcp__agent_browser__<tool>`. */
export const AGENT_BROWSER_MCP_SERVER_NAME = "agent_browser";

/** Keeps a single page read from filling the worker's context. */
const MAX_PAGE_OUTPUT_CHARS = 20_000;

/** Gives the model time to read a snapshot before the daemon exits. */
const DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

/** Keeps Klein's daemons apart from agent-browser sessions started by hand. */
const AGENT_BROWSER_NAMESPACE = "klein";

/**
 * Browser use reaches the open web and local services, so it stays limited to
 * workers whose conversation belongs to a linked Discord user. The conversation
 * agent delegates browsing to a worker instead of holding a browser itself.
 */
export function enablesAgentBrowser(role: AgentRole, browserUserId: string | undefined): boolean {
  return role.kind === "worker" && browserUserId !== undefined;
}

/** A Discord user id is safe as a session name and directory name once sanitized. */
export function browserProfileKey(userId: string): string {
  return userId.replaceAll(/[^0-9A-Za-z_-]/g, "_");
}

/** The profile dir keeps cookies, storage, and service workers between runs. */
export function createAgentBrowserProfileDirectory(agentDir: string, userId: string): string {
  return resolve(agentDir, "browser-profiles", browserProfileKey(userId));
}

/**
 * Vercel's agent-browser as an MCP server. The core profile covers navigation,
 * snapshots, interaction, waits, screenshots, and page evaluation; account,
 * cookie, storage, network, and file tools stay unavailable.
 *
 * One browser session and profile belong to one Discord user, so every channel
 * that user linked shares tabs and login state. Chrome allows only one instance
 * per profile directory, which is why the session is per user rather than per
 * worker.
 */
export function createAgentBrowserMcpConfig(userId: string, profileDirectory: string) {
  return {
    command: "agent-browser",
    args: ["mcp", "--tools", "core"],
    env: {
      AGENT_BROWSER_SESSION: `discord-user-${browserProfileKey(userId)}`,
      AGENT_BROWSER_PROFILE: profileDirectory,
      AGENT_BROWSER_NAMESPACE,
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
      AGENT_BROWSER_MAX_OUTPUT: String(MAX_PAGE_OUTPUT_CHARS),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: String(DAEMON_IDLE_TIMEOUT_MS),
    },
    exposure: "deferred",
    description:
      "Drive a real headless Chrome browser: open pages, read them, click, fill forms, wait for content, and take screenshots.",
    timeout: 120,
  } as const satisfies McpServerConfig;
}

export function createAgentBrowserMcpExtension(
  userId: string,
  profileDirectory: string,
): ExtensionFactory {
  return (pi) => {
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    pi.registerMcpServer(
      AGENT_BROWSER_MCP_SERVER_NAME,
      createAgentBrowserMcpConfig(userId, profileDirectory),
    );
  };
}
