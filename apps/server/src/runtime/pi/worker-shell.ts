import { homedir, userInfo } from "node:os";
import { delimiter, resolve } from "node:path";

import {
  createBashTool,
  createLocalBashOperations,
  type BashSpawnContext,
} from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "@agents/core/agent-role";
import type { UserEnvironment } from "@shared/user-environment";
import type { PiTool } from "./pi-tool";
import {
  createUserShellTool,
  DEFAULT_SHELL_COMMAND_TIMEOUT_SECONDS,
  SHELL_COMMAND_MAX_OUTPUT_BYTES,
  type ShellCommandOptions,
  type ShellCommandResult,
} from "./user-shell-sandbox";

export interface HostWorkerShell {
  readonly kind: "host";
  readonly homeDirectory: string;
}

export interface SandboxedWorkerShell {
  readonly kind: "sandbox";
  readonly environment: UserEnvironment;
}

export type WorkerShell = HostWorkerShell | SandboxedWorkerShell;

/**
 * Host variables that are safe to hand to a worker shell. Anything else, in
 * particular Klein's own tokens and configuration paths, stays out.
 */
const HOST_ENVIRONMENT_VARIABLES = [
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "NIX_REMOTE",
  "NIX_PATH",
  "NIX_PROFILES",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const PI_SESSION_ENVIRONMENT_VARIABLES = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

const FALLBACK_SHELL_PATH = "/usr/local/bin:/usr/bin:/bin";

export function hostHomeDirectory(): string {
  return homedir();
}

/**
 * An owner worker runs on the host so it can use the owner's repositories,
 * dotfiles, and installed CLIs. Every other worker stays in its linked user's
 * bubblewrap sandbox. Both need the linked user's environment for the browser
 * profile and secret storage.
 */
export function resolveWorkerShell(input: {
  readonly role: AgentRole;
  readonly ownerFeaturesAllowed: boolean;
  readonly environment: UserEnvironment | undefined;
  readonly homeDirectory: string;
}): WorkerShell | undefined {
  if (input.role.kind !== "worker" || input.environment === undefined) return undefined;
  if (input.ownerFeaturesAllowed) return { kind: "host", homeDirectory: input.homeDirectory };
  return { kind: "sandbox", environment: input.environment };
}

export function workerShellCwd(shell: WorkerShell | undefined): string {
  if (shell === undefined) return process.cwd();
  return shell.kind === "host" ? shell.homeDirectory : shell.environment.workspaceDirectory;
}

export function createWorkerShellTool(shell: WorkerShell): PiTool {
  return shell.kind === "host"
    ? createHostShellTool(shell.homeDirectory)
    : createUserShellTool(shell.environment);
}

function createHostShellTool(homeDirectory: string): PiTool {
  return createBashTool(homeDirectory, {
    spawnHook: (context: BashSpawnContext) => ({
      ...context,
      // context.env carries the PI_SESSION_* values the tool added; rebuilding
      // from process.env would drop them.
      env: hostShellEnvironment(context.env, homeDirectory),
    }),
  });
}

/**
 * Builds the environment for a host worker shell. Only an allowlist of host
 * variables reaches the worker, and `HOME` always points at the host home.
 */
export function hostShellEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  secretEnvironment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [...HOST_ENVIRONMENT_VARIABLES, ...PI_SESSION_ENVIRONMENT_VARIABLES]) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }

  const user = environment.USER || environment.LOGNAME || userInfo().username;
  result.HOME = homeDirectory;
  result.USER = user;
  result.LOGNAME = user;
  result.LANG = environment.LANG ?? "C.UTF-8";
  result.TERM = environment.TERM ?? "dumb";
  result.PATH = hostShellPath(environment.PATH, homeDirectory);

  // Secret aliases are validated not to replace PATH, HOME, or the other
  // variables above, so they are the last values applied.
  return { ...result, ...secretEnvironment };
}

function hostShellPath(path: string | undefined, homeDirectory: string): string {
  const localBin = resolve(homeDirectory, ".local", "bin");
  const entries = (path ? path : FALLBACK_SHELL_PATH).split(delimiter).filter(Boolean);
  return entries.includes(localBin)
    ? entries.join(delimiter)
    : [localBin, ...entries].join(delimiter);
}

/**
 * Runs a command for an owner worker directly on the host with bounded output.
 * Hitting the output cap aborts the command so its process tree does not keep
 * running.
 */
export async function runHostCommand(
  homeDirectory: string,
  command: string,
  options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  let truncated = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const { exitCode } = await createLocalBashOperations().exec(command, homeDirectory, {
      onData(data) {
        if (truncated) return;
        const remaining = SHELL_COMMAND_MAX_OUTPUT_BYTES - collectedBytes;
        if (data.byteLength > remaining) {
          chunks.push(data.subarray(0, remaining));
          collectedBytes = SHELL_COMMAND_MAX_OUTPUT_BYTES;
          truncated = true;
          controller.abort();
          return;
        }
        chunks.push(data);
        collectedBytes += data.byteLength;
      },
      signal: controller.signal,
      timeout: options.timeoutSeconds ?? DEFAULT_SHELL_COMMAND_TIMEOUT_SECONDS,
      env: hostShellEnvironment(process.env, homeDirectory, options.secretEnvironment),
    });
    return {
      output: Buffer.concat(chunks).toString("utf8"),
      exitCode: truncated ? null : exitCode,
      truncated,
    };
  } catch (error) {
    if (!truncated) throw error;
    return {
      output: Buffer.concat(chunks).toString("utf8"),
      exitCode: null,
      truncated: true,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
