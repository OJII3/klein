import type { ExtensionFactory, McpServerConfig } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "@agents/core/agent-role";

/** Server tools are named `mcp__agent_browser__<tool>`. */
export const AGENT_BROWSER_MCP_SERVER_NAME = "agent_browser";

/** Keeps a single page read from filling the worker's context. */
const MAX_PAGE_OUTPUT_CHARS = 20_000;

/** Gives the model time to read a snapshot before the daemon exits. */
const DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Browser use reaches the open web and local services, so it stays
 * limited to tasks whose conversation has owner features. The conversation
 * agent delegates browsing to a worker instead of holding a browser itself.
 */
export function enablesAgentBrowser(
  role: AgentRole,
  ownerFeaturesAllowed: boolean | undefined,
): boolean {
  return role.kind === "worker" && ownerFeaturesAllowed === true;
}

/**
 * Vercel's agent-browser as an MCP server. The core profile covers navigation,
 * snapshots, interaction, waits, screenshots, and page evaluation; account,
 * cookie, storage, network, and file tools stay unavailable.
 */
export function createAgentBrowserMcpConfig(sessionKey: string) {
  return {
    command: "agent-browser",
    args: ["mcp", "--tools", "core"],
    env: {
      AGENT_BROWSER_SESSION: sessionKey,
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

/**
 * The task id names the browser session, so concurrent workers do not share
 * tabs and a resumed worker finds its previous session.
 */
export function createAgentBrowserMcpExtension(sessionKey: string): ExtensionFactory {
  return (pi) => {
    pi.registerMcpServer(AGENT_BROWSER_MCP_SERVER_NAME, createAgentBrowserMcpConfig(sessionKey));
  };
}
