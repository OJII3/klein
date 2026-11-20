import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

import { createBashTool, type BashOperations } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "@agents/core/agent-role";
import {
  userEnvironmentKey,
  userEnvironmentVariables,
  type UserEnvironment,
} from "@shared/user-environment";
import type { PiTool } from "./pi-tool";

/**
 * Host paths the sandbox may read. Everything else, including Klein's agent
 * directory and every other user's environment, stays outside the namespace.
 */
const SYSTEM_READ_ONLY_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/nix/store",
  "/run/current-system",
] as const;

/** Used when the host PATH has no usable entry inside the sandbox. */
const FALLBACK_PATH_ENTRIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

const SHELL_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

/** Files whose symlink targets may live outside the read-only system paths. */
const NETWORK_CONFIGURATION_FILES = ["/etc/resolv.conf", "/etc/hosts"] as const;

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A sandboxed shell belongs to workers started from a linked user's
 * conversation. The user environment names the only directory tree the shell
 * may write, and the shell must not fall back to running on the host.
 */
export function enablesUserShell(
  role: AgentRole,
  environment: UserEnvironment | undefined,
): environment is UserEnvironment {
  return role.kind === "worker" && environment !== undefined;
}

/** The bubblewrap binary the sandbox spawns, when it is installed. */
export function resolveBubblewrapBinary(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, "bwrap");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

/**
 * Keeps host PATH entries that also exist inside the sandbox. A per-user shell
 * therefore sees system tools and the Nix store, but not tools under the host
 * user's home or Klein's repository.
 */
export function sandboxPathEntries(hostPath: string | undefined): string[] {
  const entries: string[] = [];
  for (const entry of (hostPath ?? "").split(delimiter)) {
    if (!entry) continue;
    let resolved: string;
    try {
      resolved = realpathSync(entry);
    } catch {
      continue;
    }
    if (!SYSTEM_READ_ONLY_PATHS.some((root) => isWithinRoot(resolved, root))) continue;
    entries.push(resolved);
  }
  for (const entry of FALLBACK_PATH_ENTRIES) {
    if (existsSync(entry)) entries.push(entry);
  }
  return [...new Set(entries)];
}

export function createUserShellTool(environment: UserEnvironment): PiTool {
  return createBashTool(environment.workspaceDirectory, {
    operations: createBubblewrapBashOperations(environment),
    // The host passes the full process environment to the tool; none of it is
    // safe to expose. The sandbox gets its own variables below.
    exposeSessionEnvironment: false,
  });
}

/**
 * Runs each command in a fresh bubblewrap namespace. The shell sees a minimal
 * root with read-only system paths, the user's workspace, home, and temporary
 * directory, and no process, IPC, UTS, or cgroup visibility. Network access
 * stays shared because shell work commonly needs to download tools and data.
 */
export function createBubblewrapBashOperations(environment: UserEnvironment): BashOperations {
  return {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");

      const bubblewrap = resolveBubblewrapBinary();
      if (!bubblewrap) {
        throw new Error(
          "bubblewrap (bwrap) is required to run shell commands in a user environment",
        );
      }

      const timeoutMs = resolveTimeoutMs(timeout);
      const child = spawn(bubblewrap, buildBubblewrapArguments(environment, command), {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const onAbort = () => kill();

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const { exitCode, signalCode } = await waitForExit(child);
        if (signal?.aborted) throw new Error("aborted");
        const resolvedExitCode =
          exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: resolvedExitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function buildBubblewrapArguments(environment: UserEnvironment, command: string): string[] {
  const shell = SHELL_CANDIDATES.find((candidate) => existsSync(candidate)) ?? "/bin/sh";
  const variables = {
    ...userEnvironmentVariables(environment),
    PATH: sandboxPathEntries(process.env.PATH).join(delimiter),
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    USER: `discord-${userEnvironmentKey(environment.userId)}`,
    LOGNAME: `discord-${userEnvironmentKey(environment.userId)}`,
  };

  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",
    "--cap-drop",
    "ALL",
    ...SYSTEM_READ_ONLY_PATHS.flatMap((path) =>
      existsSync(path) ? ["--ro-bind", path, path] : [],
    ),
    ...networkConfigurationArguments(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // Credentials and every other directory in the environment stay unmounted.
    "--bind",
    environment.workspaceDirectory,
    environment.workspaceDirectory,
    "--bind",
    environment.homeDirectory,
    environment.homeDirectory,
    "--bind",
    environment.temporaryDirectory,
    environment.temporaryDirectory,
    "--chdir",
    environment.workspaceDirectory,
    "--clearenv",
    ...Object.entries(variables).flatMap(([name, value]) => ["--setenv", name, value]),
    shell,
    "-c",
    command,
  ];
}

function networkConfigurationArguments(): string[] {
  return NETWORK_CONFIGURATION_FILES.flatMap((file) => {
    if (!existsSync(file)) return [];
    const target = realpathSync(file);
    if (SYSTEM_READ_ONLY_PATHS.some((root) => isWithinRoot(target, root))) return [];
    // /etc/resolv.conf commonly points into /run, which is not mounted as a
    // whole so that host sockets stay hidden.
    return ["--ro-bind", target, target];
  });
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

function isWithinRoot(path: string, root: string): boolean {
  const relativePath = relative(root, resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode, signalCode) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, signalCode });
    });
  });
}
