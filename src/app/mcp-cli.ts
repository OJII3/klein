import { resolve } from "node:path";

import { runPiMcpCommand } from "@runtime/pi/pi-internals";

import { loadConfig } from "./config";

export interface McpCommandIo {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Tests and other callers can supply the browser instead of the platform browser. */
  openUrl?: (url: string) => void;
}

/**
 * `klein mcp <add|remove|list|login|logout>`: Pi owns the MCP servers, their sign-in flow, and
 * their credentials. This only points them at Klein's agent directory.
 */
export async function runMcpCommand(
  args: readonly string[],
  io: McpCommandIo = consoleIo,
): Promise<number> {
  const config = await loadConfig();
  const agentDir = resolve(config.runtime.agentDir);
  // Pi's credential store and project trust store read the agent directory from this variable.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return runPiMcpCommand([...args], {
    cwd: process.cwd(),
    agentDir,
    ...(io.openUrl ? { openUrl: io.openUrl } : {}),
    log: io.log,
    error: io.error,
  });
}

const consoleIo: McpCommandIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};
