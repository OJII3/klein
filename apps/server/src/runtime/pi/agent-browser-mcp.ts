import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionFactory, McpServerConfig } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "@agents/core/agent-role";
import { userEnvironmentKey, type UserEnvironment } from "@shared/user-environment";

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

/** The profile dir keeps cookies, storage, and service workers between runs. */
export function agentBrowserProfileDirectory(environment: UserEnvironment): string {
  return resolve(environment.credentialsDirectory, "browser");
}

/** Moves a profile written before per-user environments so existing logins survive. */
export function migrateLegacyAgentBrowserProfile(
  agentDir: string,
  environment: UserEnvironment,
): string {
  const profileDirectory = agentBrowserProfileDirectory(environment);
  const legacyDirectory = resolve(
    agentDir,
    "browser-profiles",
    userEnvironmentKey(environment.userId),
  );
  if (!existsSync(profileDirectory) && existsSync(legacyDirectory)) {
    mkdirSync(environment.credentialsDirectory, { recursive: true, mode: 0o700 });
    renameSync(legacyDirectory, profileDirectory);
  }
  return profileDirectory;
}

export function createAgentBrowserMcpConfig(userId: string, profileDirectory: string) {
  return {
    command: "agent-browser",
    args: ["mcp", "--tools", "core"],
    env: {
      AGENT_BROWSER_SESSION: `discord-user-${userEnvironmentKey(userId)}`,
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
