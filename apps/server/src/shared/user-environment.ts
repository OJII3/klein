import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Files and credentials that belong to one linked Discord user. Worker sessions
 * run in the workspace, and the shell sees only this directory tree.
 */
export interface UserEnvironment {
  readonly userId: string;
  readonly rootDirectory: string;
  readonly workspaceDirectory: string;
  readonly homeDirectory: string;
  readonly credentialsDirectory: string;
  readonly temporaryDirectory: string;
}

/**
 * A Discord user id is safe as a directory name once sanitized. Non-numeric ids
 * get a hash suffix so that different ids cannot collapse to the same directory.
 */
export function userEnvironmentKey(userId: string): string {
  if (/^[0-9]+$/u.test(userId)) return userId;
  const sanitized = userId.replaceAll(/[^0-9A-Za-z_-]/g, "_");
  const suffix = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `${sanitized}-${suffix}`;
}

export function resolveUserEnvironment(agentDir: string, userId: string): UserEnvironment {
  const rootDirectory = resolve(agentDir, "users", userEnvironmentKey(userId));
  return {
    userId,
    rootDirectory,
    workspaceDirectory: resolve(rootDirectory, "workspace"),
    homeDirectory: resolve(rootDirectory, "home"),
    credentialsDirectory: resolve(rootDirectory, "credentials"),
    temporaryDirectory: resolve(rootDirectory, "tmp"),
  };
}

/**
 * Creates the environment with owner-only permissions and repairs existing
 * directories. A symlink or a directory owned by another user is rejected
 * instead of being followed into an unrelated tree.
 */
export function ensureUserEnvironment(environment: UserEnvironment): UserEnvironment {
  const usersDirectory = dirname(environment.rootDirectory);
  const directories = [
    environment.rootDirectory,
    environment.workspaceDirectory,
    environment.homeDirectory,
    environment.credentialsDirectory,
    environment.temporaryDirectory,
  ];

  for (const directory of [usersDirectory, ...directories]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`User environment path is not a real directory: ${directory}`);
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid) {
        throw new Error(`User environment path is not owned by the current user: ${directory}`);
      }
      chmodSync(directory, 0o700);
    }
  }

  const resolvedRoot = realpathSync(environment.rootDirectory);
  for (const directory of directories.slice(1)) {
    if (!isWithinDirectory(resolvedRoot, realpathSync(directory))) {
      throw new Error(`User environment path escapes the user's root: ${directory}`);
    }
  }

  return environment;
}

function isWithinDirectory(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

/** Environment variables that keep a user's tools inside their own environment. */
export function userEnvironmentVariables(
  environment: UserEnvironment,
): Readonly<Record<string, string>> {
  const home = environment.homeDirectory;
  return {
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, ".config"),
    XDG_CACHE_HOME: resolve(home, ".cache"),
    XDG_DATA_HOME: resolve(home, ".local", "share"),
    XDG_STATE_HOME: resolve(home, ".local", "state"),
    TMPDIR: environment.temporaryDirectory,
  };
}
