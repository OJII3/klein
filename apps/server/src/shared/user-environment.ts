import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Files and credentials that belong to one linked Discord user. Worker sessions
 * run in the workspace, and a future shell will see only this directory tree.
 */
export interface UserEnvironment {
  readonly userId: string;
  readonly rootDirectory: string;
  readonly workspaceDirectory: string;
  readonly homeDirectory: string;
  readonly credentialsDirectory: string;
  readonly temporaryDirectory: string;
}

/** A Discord user id is safe as a directory name once sanitized. */
export function userEnvironmentKey(userId: string): string {
  return userId.replaceAll(/[^0-9A-Za-z_-]/g, "_");
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

/** Creates the environment with owner-only permissions. Existing files are kept. */
export function ensureUserEnvironment(environment: UserEnvironment): UserEnvironment {
  for (const directory of [
    environment.rootDirectory,
    environment.workspaceDirectory,
    environment.homeDirectory,
    environment.credentialsDirectory,
    environment.temporaryDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return environment;
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
