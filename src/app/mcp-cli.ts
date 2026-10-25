import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  createDefaultTransport,
  loadMcpConfig,
  McpOAuthCredentialStore,
  McpServerConnection,
  McpSignInCancelledError,
  signInMcpServer,
} from "@runtime/pi/pi-durable-mcp";

import { loadConfig } from "./config";

const USAGE = "Usage: klein mcp login <server>";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface McpCommandIo {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Tests and other callers can supply the redirect URL instead of a browser callback. */
  promptForRedirectUrl?: (signal: AbortSignal) => Promise<string | undefined>;
  openUrl?: (url: string) => void;
}

/**
 * `klein mcp login <server>`: connect to a remote MCP server and, when it answers 401, run the
 * OAuth authorization code flow. The browser delivers the callback to a loopback server; users on
 * another machine can paste the redirect URL instead.
 */
export async function runMcpCommand(
  args: readonly string[],
  io: McpCommandIo = consoleIo,
): Promise<number> {
  const [command, name, ...extra] = args;
  if (command !== "login" || !name || extra.length > 0) {
    io.error(USAGE);
    return 2;
  }
  const config = await loadConfig();
  const agentDir = resolve(config.runtime.agentDir);
  const loaded = loadMcpConfig({ agentDir, cwd: process.cwd(), projectTrusted: true });
  for (const error of loaded.errors) io.error(`MCP config: ${error}`);
  const entry = loaded.servers.find((server) => server.name === name);
  if (!entry) {
    io.error(`No MCP server named "${name}" in ${join(agentDir, "mcp.json")}.`);
    return 1;
  }

  const credentials = new McpOAuthCredentialStore(agentDir);
  const connection = new McpServerConnection({
    entry,
    cwd: process.cwd(),
    createTransport: createDefaultTransport,
    credentials,
    onTools: () => undefined,
  });
  try {
    const url = connection.oauthUrl;
    if (!url) {
      io.error(
        `MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`,
      );
      return 1;
    }
    try {
      await connection.getClient();
      io.log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
      return 0;
    } catch {
      if (connection.state !== "needs-auth") {
        io.error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
        return 1;
      }
    }

    const interactive = process.stdin.isTTY === true;
    try {
      await signInMcpServer({
        serverUrl: url,
        store: credentials.forServer(name, url),
        settings: connection.oauthSettings(),
        challenge: connection.challenge,
        prompt: {
          showAuthorizationUrl: (authorizationUrl) => {
            io.log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
            (io.openUrl ?? openExternalUrl)(authorizationUrl.href);
          },
          promptForRedirectUrl:
            io.promptForRedirectUrl ?? ((signal) => waitForRedirectUrl(signal, interactive)),
        },
        signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof McpSignInCancelledError) {
        io.error(
          `Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(SIGN_IN_TIMEOUT_MS / 1000)} seconds.`,
        );
      } else {
        io.error(`Sign-in to MCP server "${name}" failed: ${errorMessage(error)}`);
      }
      return 1;
    }
    try {
      await connection.getClient();
      io.log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
      return 0;
    } catch (error) {
      io.error(`Signed in, but ${errorMessage(error)}`);
      return 1;
    }
  } finally {
    await connection.close();
  }
}

const consoleIo: McpCommandIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pasted redirect URL in a terminal; without one, only the browser callback can finish the
 * sign-in. Resolves to undefined when `signal` aborts: the callback arrived, or sign-in timed out.
 */
async function waitForRedirectUrl(
  signal: AbortSignal,
  interactive: boolean,
): Promise<string | undefined> {
  if (!interactive) {
    if (!signal.aborted) {
      await new Promise<void>((resolveWait) =>
        signal.addEventListener("abort", () => resolveWait(), { once: true }),
      );
    }
    return undefined;
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(
      "If the browser cannot reach this machine, paste the URL it was redirected to: ",
      { signal },
    );
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}

function openExternalUrl(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    // A headless machine has no browser; the URL is printed, so failing to open one is harmless.
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Ignored for the same reason.
  }
}
