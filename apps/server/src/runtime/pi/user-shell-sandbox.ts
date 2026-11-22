import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
const NETWORK_CONFIGURATION_FILES = ["/etc/hosts"] as const;

const RESOLV_CONF_PATH = "/etc/resolv.conf";
const SANDBOX_RESOLV_CONF_FILE = "resolv.conf";
const DEFAULT_DNS_SERVER = "1.1.1.1";
const MAX_DNS_HOSTS = 2;

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The path in the sandbox where secret variables are sourced from. */
const SECRET_ENVIRONMENT_TARGET = "/run/klein/secrets.env";
const SECRET_ENVIRONMENT_DIRECTORY = "secret-runtime";
const SECRET_ENVIRONMENT_FILE_MAX_AGE_MS = 60 * 60 * 1_000;

/** A tool result should stay readable; the command may still produce more. */
export const SANDBOXED_COMMAND_MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Loose per-process limits set inside the sandbox. They are backstops against
 * runaway commands, not a replacement for cgroup memory and disk quotas. The
 * hard limits keep a child from raising them again.
 */
const SHELL_ULIMITS = [
  "ulimit -H -c 0 2>/dev/null || true",
  "ulimit -S -c 0 2>/dev/null || true",
  "ulimit -H -f 2097152 2>/dev/null || true",
  "ulimit -S -f 2097152 2>/dev/null || true",
  "ulimit -H -n 8192 2>/dev/null || true",
  "ulimit -S -n 8192 2>/dev/null || true",
  "ulimit -H -u 2048 2>/dev/null || true",
  "ulimit -S -u 2048 2>/dev/null || true",
  "ulimit -H -v 8388608 2>/dev/null || true",
  "ulimit -S -v 8388608 2>/dev/null || true",
  "ulimit -H -t 3600 2>/dev/null || true",
  "ulimit -S -t 3600 2>/dev/null || true",
] as const;

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

function resolveExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

export function resolveBubblewrapBinary(): string | undefined {
  return resolveExecutable("bwrap");
}

export function resolvePastaBinary(): string | undefined {
  return resolveExecutable("pasta");
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

export interface SandboxedCommandOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  /** Values are exported only to this command, never written to the workspace. */
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface SandboxedCommandResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

/**
 * Runs a command for a worker and returns bounded output. Secret values
 * are passed through an owner-only file that is bind-mounted readonly into the
 * sandbox, so they never appear in process arguments or the workspace.
 */
export async function runSandboxedCommand(
  environment: UserEnvironment,
  command: string,
  options: SandboxedCommandOptions = {},
): Promise<SandboxedCommandResult> {
  const chunks: Buffer[] = [];
  let collectedBytes = 0;
  let truncated = false;
  const operations = createBubblewrapBashOperations(
    environment,
    {
      defaultTimeoutSeconds: options.timeoutSeconds,
      maxOutputBytes: SANDBOXED_COMMAND_MAX_OUTPUT_BYTES * 2,
    },
    options.secretEnvironment,
  );

  try {
    const { exitCode } = await operations.exec(command, environment.workspaceDirectory, {
      onData(data) {
        if (collectedBytes >= SANDBOXED_COMMAND_MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const remaining = SANDBOXED_COMMAND_MAX_OUTPUT_BYTES - collectedBytes;
        if (data.byteLength > remaining) {
          chunks.push(data.subarray(0, remaining));
          collectedBytes = SANDBOXED_COMMAND_MAX_OUTPUT_BYTES;
          truncated = true;
          return;
        }
        chunks.push(data);
        collectedBytes += data.byteLength;
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutSeconds !== undefined ? { timeout: options.timeoutSeconds } : {}),
    });
    return {
      output: Buffer.concat(chunks).toString("utf8"),
      exitCode,
      truncated,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("output limit exceeded")) {
      return {
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: null,
        truncated: true,
      };
    }
    throw error;
  }
}

export interface SandboxDns {
  /** Address written to the sandbox's resolv.conf and intercepted by pasta. */
  readonly forward: string;
  /** Host resolvers pasta forwards DNS queries to. */
  readonly hosts: readonly string[];
}

/**
 * Picks DNS servers for the sandbox. systemd-resolved commonly exposes a
 * loopback stub, which is unreachable from pasta's netns, so loopback entries
 * are dropped in favour of the default gateway.
 */
export function resolveSandboxDns(
  read: (path: string) => string = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
): SandboxDns {
  const nameservers = [
    ...parseNameservers(read("/run/systemd/resolve/resolv.conf")),
    ...parseNameservers(read(RESOLV_CONF_PATH)),
  ];
  const unique = [...new Set(nameservers)].slice(0, MAX_DNS_HOSTS);
  const gateway = parseDefaultIpv4Gateway(read("/proc/net/route"));
  const forward = gateway ?? unique[0] ?? DEFAULT_DNS_SERVER;
  const hosts = [...new Set([...unique, ...(gateway ? [gateway] : [])])].slice(0, MAX_DNS_HOSTS);

  return { forward, hosts: hosts.length > 0 ? hosts : [DEFAULT_DNS_SERVER] };
}

export function parseNameservers(content: string): string[] {
  const nameservers = content.split("\n").flatMap((line) => {
    const match = /^\s*nameserver\s+(\S+)/u.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  return [...new Set(nameservers.filter((address) => isRoutableNameserver(address)))];
}

function isRoutableNameserver(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower !== "::1" &&
    lower !== "0.0.0.0" &&
    !lower.startsWith("127.") &&
    !lower.startsWith("::ffff:127.") &&
    !lower.startsWith("fe80:")
  );
}

export function parseDefaultIpv4Gateway(content: string): string | undefined {
  for (const line of content.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 3) continue;
    const destination = columns[1];
    const gateway = columns[2];
    if (destination !== "00000000" || gateway === undefined || gateway === "00000000") continue;
    const octets = gateway.match(/../gu);
    if (!octets || octets.length !== 4) continue;
    return octets
      .toReversed()
      .map((octet) => Number.parseInt(octet, 16))
      .join(".");
  }
  return undefined;
}

export interface UserShellLimits {
  /** Wall-clock timeout used when the tool call does not pass one. */
  readonly defaultTimeoutSeconds?: number;
  /** Total output bytes before the command is killed. */
  readonly maxOutputBytes?: number;
}

/**
 * Runs each command in a pasta network namespace and a fresh bubblewrap
 * namespace. Pasta provides outbound NAT while keeping the host's loopback and
 * its local listeners out of reach. Filesystem access stays limited to the
 * user's workspace, home, and temporary directory.
 */
export function createBubblewrapBashOperations(
  environment: UserEnvironment,
  limits: UserShellLimits = {},
  secretEnvironment?: Readonly<Record<string, string>>,
): BashOperations {
  return {
    exec: async (command, _cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");

      const bubblewrap = resolveBubblewrapBinary();
      if (!bubblewrap) {
        throw new Error(
          "bubblewrap (bwrap) is required to run shell commands in a user environment",
        );
      }
      const pasta = resolvePastaBinary();
      if (!pasta) {
        throw new Error("pasta (passt) is required to run shell commands in a user environment");
      }

      const effectiveTimeout = timeout ?? limits.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const timeoutMs = resolveTimeoutMs(effectiveTimeout);
      const dns = resolveSandboxDns();
      writeSandboxResolvConf(environment, dns);
      const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      const secretFile = secretEnvironment
        ? writeSecretEnvironmentFile(environment, secretEnvironment)
        : undefined;

      try {
        const pastaArguments = buildPastaArguments(
          bubblewrap,
          environment,
          command,
          dns,
          secretFile,
        );
        // Keep the sandbox tied to Klein's lifetime even though pasta sits between
        // them; `--die-with-parent` alone only follows pasta.
        const setpriv = resolveExecutable("setpriv");
        const child = setpriv
          ? spawn(setpriv, ["--pdeathsig", "SIGKILL", "--", pasta, ...pastaArguments], {
              cwd: "/",
              env: { PATH: "/usr/bin:/bin" },
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn(pasta, pastaArguments, {
              cwd: "/",
              env: { PATH: "/usr/bin:/bin" },
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });

        let outputBytes = 0;
        let outputLimitExceeded = false;
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
        const handleData = (data: Buffer) => {
          if (outputLimitExceeded) return;
          outputBytes += data.byteLength;
          if (outputBytes > maxOutputBytes) {
            outputLimitExceeded = true;
            kill();
            return;
          }
          onData(data);
        };

        try {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs);
          child.stdout?.on("data", handleData);
          child.stderr?.on("data", handleData);
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }

          const { exitCode, signalCode } = await waitForExit(child);
          if (signal?.aborted) throw new Error("aborted");
          if (outputLimitExceeded) {
            throw new Error(`output limit exceeded: ${maxOutputBytes} bytes`);
          }
          if (timedOut) throw new Error(`timeout:${effectiveTimeout}`);
          const resolvedExitCode =
            exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
          return { exitCode: resolvedExitCode };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        if (secretFile) removeSecretEnvironmentFile(secretFile);
      }
    },
  };
}

export function buildPastaArguments(
  bubblewrap: string,
  environment: UserEnvironment,
  command: string,
  dns: SandboxDns,
  secretEnvironmentFile?: string,
): string[] {
  return [
    "-q",
    "-f",
    "--config-net",
    "--no-map-gw",
    "-t",
    "none",
    "-u",
    "none",
    "-T",
    "none",
    "-U",
    "none",
    ...dns.hosts.flatMap((host) => ["--dns-host", host]),
    "--dns-forward",
    dns.forward,
    "--",
    bubblewrap,
    ...buildBubblewrapArguments(environment, command, secretEnvironmentFile),
  ];
}

export function buildBubblewrapArguments(
  environment: UserEnvironment,
  command: string,
  secretEnvironmentFile?: string,
): string[] {
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
    "--unshare-user-try",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--cap-drop",
    "ALL",
    ...SYSTEM_READ_ONLY_PATHS.flatMap((path) =>
      existsSync(path) ? ["--ro-bind", path, path] : [],
    ),
    ...networkConfigurationArguments(environment),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...(secretEnvironmentFile
      ? [
          "--dir",
          "/run",
          "--dir",
          "/run/klein",
          "--ro-bind",
          secretEnvironmentFile,
          SECRET_ENVIRONMENT_TARGET,
        ]
      : []),
    // Secrets and every other directory in the environment stay unmounted.
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
    `${SHELL_ULIMITS.join("\n")}\n${
      secretEnvironmentFile ? `set -a\n. ${SECRET_ENVIRONMENT_TARGET}\nset +a\n` : ""
    }${command}`,
  ];
}

function writeSandboxResolvConf(environment: UserEnvironment, dns: SandboxDns): void {
  const path = resolve(environment.credentialsDirectory, SANDBOX_RESOLV_CONF_FILE);
  writeFileSync(path, `nameserver ${dns.forward}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeSecretEnvironmentFile(
  environment: UserEnvironment,
  variables: Readonly<Record<string, string>>,
): string | undefined {
  const entries = Object.entries(variables);
  if (entries.length === 0) return undefined;
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid secret environment name: ${name}`);
    }
    if (value.includes("\u0000")) {
      throw new Error(`Secret value for ${name} contains a NUL byte`);
    }
  }

  // The file lives in the credentials directory, which is otherwise not
  // mounted. Only this one file is bound into the command's namespace.
  const directory = resolve(environment.credentialsDirectory, SECRET_ENVIRONMENT_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  sweepStaleSecretEnvironmentFiles(directory);

  const path = resolve(directory, `${randomUUID()}.env`);
  const content = entries
    .map(([name, value]) => `export ${name}=${quoteShellValue(value)}`)
    .join("\n");
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function removeSecretEnvironmentFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The file is owner-only and short-lived; a failed cleanup is not fatal.
  }
}

function sweepStaleSecretEnvironmentFiles(directory: string, now = Date.now()): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".env")) continue;
    const path = resolve(directory, entry.name);
    try {
      if (now - statSync(path).mtimeMs >= SECRET_ENVIRONMENT_FILE_MAX_AGE_MS) {
        unlinkSync(path);
      }
    } catch {
      // A concurrent run may have removed it already.
    }
  }
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function networkConfigurationArguments(environment: UserEnvironment): string[] {
  const argumentsForFiles = NETWORK_CONFIGURATION_FILES.flatMap((file) => {
    if (!existsSync(file)) return [];
    const target = realpathSync(file);
    if (SYSTEM_READ_ONLY_PATHS.some((root) => isWithinRoot(target, root))) return [];
    return ["--ro-bind", target, target];
  });
  const sandboxResolvConf = resolve(environment.credentialsDirectory, SANDBOX_RESOLV_CONF_FILE);
  if (existsSync(sandboxResolvConf) && existsSync(RESOLV_CONF_PATH)) {
    return [...argumentsForFiles, "--ro-bind", sandboxResolvConf, realpathSync(RESOLV_CONF_PATH)];
  }
  return [...argumentsForFiles, ...hostResolvConfArguments()];
}

function hostResolvConfArguments(): string[] {
  if (!existsSync(RESOLV_CONF_PATH)) return [];
  const target = realpathSync(RESOLV_CONF_PATH);
  if (SYSTEM_READ_ONLY_PATHS.some((root) => isWithinRoot(target, root))) return [];
  return ["--ro-bind", target, target];
}

function resolveTimeoutMs(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeout * 1000;
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
