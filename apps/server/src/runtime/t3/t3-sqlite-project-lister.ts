import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { T3Project, T3ProjectLister } from "@agents/tools/t3-project";

const MAX_PROJECTS = 100;
const BUSY_TIMEOUT_MS = 1_000;

export interface T3SqliteProjectListerOptions {
  /** T3 Code data directory. Defaults to T3CODE_HOME or ~/.t3-service. */
  readonly baseDir?: string;
}

/**
 * Reads T3 Code's project projection because the `t3` CLI has no project list
 * command. The query is read-only and isolated here so it can be replaced when
 * the CLI exposes projects directly.
 */
export function createT3SqliteProjectLister(
  options: T3SqliteProjectListerOptions = {},
): T3ProjectLister {
  const baseDir = options.baseDir ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3-service");
  const databasePath = join(baseDir, "userdata", "statev2.sqlite");

  return {
    async list(signal) {
      if (signal?.aborted) throw new Error("T3 Code project listing was aborted");
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        const rows = database
          .prepare(
            `SELECT project_id AS id, title, workspace_root AS workspaceRoot
             FROM projection_projects
             WHERE deleted_at IS NULL AND archived_at IS NULL
             ORDER BY created_at ASC
             LIMIT ?`,
          )
          .all(MAX_PROJECTS) as readonly Record<string, unknown>[];
        return rows.map((row): T3Project => ({
          id: String(row.id),
          title: String(row.title),
          workspaceRoot: String(row.workspaceRoot),
        }));
      } catch (error) {
        throw new Error(
          `Failed to read T3 Code projects from ${databasePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      } finally {
        database?.close();
      }
    },
  };
}
