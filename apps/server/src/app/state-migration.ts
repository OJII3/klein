import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { Logger } from "pino";

import { getErrorCode, isFileNotFound } from "@shared/type-guards";

const LEGACY_DIRECTORIES = [
  "channel-sessions",
  "workers",
  "schedules",
  "channel-rules",
  "proactive",
  "initiative",
] as const;

const LEGACY_FILES = [
  "discord-users.json",
  "discord-access.json",
  "discord-access-requests.json",
  "discord-channel-links.json",
  "discord-channel-link-requests.json",
  "secret-requests.json",
] as const;

type LegacyKind = "directory" | "file";
type StateMigrationLogger = Pick<Logger, "info" | "warn">;

export interface StateMigrationOptions {
  readonly agentDir: string;
  readonly stateDir: string;
  readonly logger: StateMigrationLogger;
  /** State directories that only move when the caller knows they use the default path. */
  readonly extraDirectories?: readonly string[];
}

/**
 * Moves mutable runtime state from `agentDir` to `stateDir` once. Pi sessions, credentials and
 * user environments stay in `agentDir`; only the paths listed here move.
 */
export async function migrateStateDirectories({
  agentDir,
  stateDir,
  logger,
  extraDirectories = [],
}: StateMigrationOptions): Promise<void> {
  const sourceRoot = resolve(agentDir);
  const targetRoot = resolve(stateDir);
  if (sourceRoot === targetRoot) return;

  await mkdir(targetRoot, { recursive: true });
  for (const name of new Set([...LEGACY_DIRECTORIES, ...extraDirectories])) {
    await moveLegacyPath("directory", name, sourceRoot, targetRoot, logger);
  }
  for (const name of LEGACY_FILES) {
    await moveLegacyPath("file", name, sourceRoot, targetRoot, logger);
  }
}

async function moveLegacyPath(
  kind: LegacyKind,
  name: string,
  sourceRoot: string,
  targetRoot: string,
  logger: StateMigrationLogger,
): Promise<void> {
  const source = resolve(sourceRoot, name);
  const target = resolve(targetRoot, name);
  if (!(await pathExists(source))) return;

  if (await pathExists(target)) {
    logger.warn(
      { event: "state_path_migration_conflict", kind, name, from: source, to: target },
      "Both the legacy and the new state path exist; keeping both",
    );
    return;
  }

  await movePath(kind, source, target);
  logger.info(
    { event: "state_path_migrated", kind, name, from: source, to: target },
    "Moved state path out of the agent directory",
  );
}

async function movePath(kind: LegacyKind, source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if (getErrorCode(error) !== "EXDEV") throw error;
  }

  // A custom stateDir can sit on another filesystem. Copy to a staging path first so a crash
  // never leaves a partial copy at the destination where the legacy path would hide it.
  const staging = `${target}.migrating-${randomUUID()}`;
  try {
    if (kind === "directory") {
      await cp(source, staging, { recursive: true });
    } else {
      await copyFile(source, staging);
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rm(source, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}
