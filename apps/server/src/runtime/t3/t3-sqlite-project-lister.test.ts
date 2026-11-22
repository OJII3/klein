import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createT3SqliteProjectLister } from "./t3-sqlite-project-lister";

interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdDay: number;
  readonly deletedAt?: string;
  readonly archivedAt?: string;
}

async function createProjectDatabase(projects: readonly ProjectRow[]): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "klein-t3-projects-"));
  const userdata = join(baseDir, "userdata");
  await mkdir(userdata);
  const database = new DatabaseSync(join(userdata, "statev2.sqlite"));
  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      archived_at TEXT
    )
  `);
  const insert = database.prepare(
    `INSERT INTO projection_projects
      (project_id, title, workspace_root, created_at, deleted_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const project of projects) {
    insert.run(
      project.id,
      project.title,
      project.workspaceRoot,
      `2026-01-${String(project.createdDay).padStart(2, "0")}T00:00:00.000Z`,
      project.deletedAt ?? null,
      project.archivedAt ?? null,
    );
  }
  database.close();
  return baseDir;
}

test("lists active projects in creation order", async () => {
  const baseDir = await createProjectDatabase([
    { id: "dotfiles-id", title: "dotfiles", workspaceRoot: "/work/dotfiles", createdDay: 1 },
    {
      id: "deleted-id",
      title: "deleted",
      workspaceRoot: "/work/deleted",
      createdDay: 2,
      deletedAt: "2026-01-02T00:00:00.000Z",
    },
    { id: "klein-id", title: "klein", workspaceRoot: "/work/klein", createdDay: 3 },
    {
      id: "archived-id",
      title: "archived",
      workspaceRoot: "/work/archived",
      createdDay: 4,
      archivedAt: "2026-01-04T00:00:00.000Z",
    },
  ]);
  const lister = createT3SqliteProjectLister({ baseDir });

  const projects = await lister.list();

  assert.deepEqual(projects, [
    { id: "dotfiles-id", title: "dotfiles", workspaceRoot: "/work/dotfiles" },
    { id: "klein-id", title: "klein", workspaceRoot: "/work/klein" },
  ]);
});

test("fails with the database path when T3 state is unavailable", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "klein-t3-missing-"));
  const lister = createT3SqliteProjectLister({ baseDir });

  await assert.rejects(lister.list(), /Failed to read T3 Code projects from .*statev2\.sqlite/);
});
