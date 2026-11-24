import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import pino from "pino";

import { getErrorCode, isRecord, parseJson } from "@shared/type-guards";

import { createTempDir } from "../testing/temp-dir";
import { migrateStateDirectories } from "./state-migration";

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

function createRecordingLogger() {
  const logs: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write(line: string) {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) logs.push(parsed);
      },
    },
  );
  return { logger, logs };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function writeLegacyState(agentDir: string): Promise<void> {
  for (const name of LEGACY_DIRECTORIES) {
    await mkdir(join(agentDir, name, "nested"), { recursive: true });
    await writeFile(join(agentDir, name, "nested", "record.json"), JSON.stringify({ from: name }));
  }
  for (const name of LEGACY_FILES) {
    await writeFile(join(agentDir, name), JSON.stringify({ from: name }));
  }
}

test("moves the legacy state directories and files into the state directory", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  await writeLegacyState(agentDir);
  const { logger, logs } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });

  for (const name of LEGACY_DIRECTORIES) {
    assert.deepEqual(
      parseJson(await readFile(join(stateDir, name, "nested", "record.json"), "utf8")),
      { from: name },
    );
    assert.equal(await exists(join(agentDir, name)), false);
  }
  for (const name of LEGACY_FILES) {
    assert.deepEqual(parseJson(await readFile(join(stateDir, name), "utf8")), { from: name });
    assert.equal(await exists(join(agentDir, name)), false);
  }

  const moved = logs.filter((entry) => entry.event === "state_path_migrated");
  assert.equal(moved.length, LEGACY_DIRECTORIES.length + LEGACY_FILES.length);
  assert.deepEqual(
    moved.map((entry) => [entry.kind, entry.name]),
    [
      ...LEGACY_DIRECTORIES.map((name) => ["directory", name]),
      ...LEGACY_FILES.map((name) => ["file", name]),
    ],
  );
  assert.equal(moved[0]?.from, join(agentDir, "channel-sessions"));
  assert.equal(moved[0]?.to, join(stateDir, "channel-sessions"));
});

test("does nothing on a second run", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  await writeLegacyState(agentDir);
  const { logger, logs } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });
  const firstRunLogCount = logs.length;
  await migrateStateDirectories({ agentDir, stateDir, logger });

  assert.equal(logs.length, firstRunLogCount);
  assert.deepEqual(parseJson(await readFile(join(stateDir, "discord-users.json"), "utf8")), {
    from: "discord-users.json",
  });
  assert.deepEqual(
    parseJson(await readFile(join(stateDir, "workers", "nested", "record.json"), "utf8")),
    { from: "workers" },
  );
});

test("keeps both copies when the destination already exists", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  await mkdir(join(agentDir, "workers"), { recursive: true });
  await writeFile(join(agentDir, "workers", "legacy.json"), "legacy");
  await mkdir(join(stateDir, "workers"), { recursive: true });
  await writeFile(join(stateDir, "workers", "current.json"), "current");
  await writeFile(join(agentDir, "discord-users.json"), "legacy");
  await writeFile(join(stateDir, "discord-users.json"), "current");
  const { logger, logs } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });

  assert.equal(await readFile(join(agentDir, "workers", "legacy.json"), "utf8"), "legacy");
  assert.equal(await readFile(join(stateDir, "workers", "current.json"), "utf8"), "current");
  assert.equal(await exists(join(stateDir, "workers", "legacy.json")), false);
  assert.equal(await readFile(join(agentDir, "discord-users.json"), "utf8"), "legacy");
  assert.equal(await readFile(join(stateDir, "discord-users.json"), "utf8"), "current");
  assert.deepEqual(
    logs
      .filter((entry) => entry.event === "state_path_migration_conflict")
      .map((entry) => entry.name),
    ["workers", "discord-users.json"],
  );
});

test("ignores legacy paths that do not exist", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  await mkdir(agentDir, { recursive: true });
  const { logger, logs } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });

  assert.equal(await exists(stateDir), true);
  assert.deepEqual(await readdir(stateDir), []);
  assert.deepEqual(logs, []);
});

test("leaves Pi sessions, credentials, secrets and memory in the agent directory", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  const untouched = [
    "sessions/conversation.json",
    "mcp.json",
    "auth.json",
    "auth-requests.json",
    "mcp-auth.json",
    "models-store.json",
    "secret-key",
    "secrets/token",
    "user-memory/owner.md",
    "shared-memory/channel.md",
  ];
  for (const path of untouched) {
    await mkdir(dirname(join(agentDir, path)), { recursive: true });
    await writeFile(join(agentDir, path), "keep");
  }
  await writeFile(join(agentDir, "secret-requests.json"), "{}");
  const { logger } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });

  for (const path of untouched) {
    assert.equal(await readFile(join(agentDir, path), "utf8"), "keep");
    assert.equal(await exists(join(stateDir, path)), false);
  }
  assert.equal(await exists(join(stateDir, "secret-requests.json")), true);
});

test("does nothing when the agent directory and state directory are the same", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  await writeFile(join(temp.path, "discord-users.json"), "keep");
  await mkdir(join(temp.path, "workers"));
  const { logger, logs } = createRecordingLogger();

  await migrateStateDirectories({ agentDir: temp.path, stateDir: temp.path, logger });

  assert.equal(await readFile(join(temp.path, "discord-users.json"), "utf8"), "keep");
  assert.equal(await exists(join(temp.path, "workers")), true);
  assert.deepEqual(logs, []);
});

test("moves user memory only when the caller opts in", async () => {
  await using temp = await createTempDir("klein-state-migration-");
  const agentDir = join(temp.path, "agent");
  const stateDir = join(temp.path, "state");
  await mkdir(join(agentDir, "user-memory"), { recursive: true });
  await writeFile(join(agentDir, "user-memory", "owner.md"), "memory");
  const { logger } = createRecordingLogger();

  await migrateStateDirectories({ agentDir, stateDir, logger });
  assert.equal(await readFile(join(agentDir, "user-memory", "owner.md"), "utf8"), "memory");
  assert.equal(await exists(join(stateDir, "user-memory")), false);

  await migrateStateDirectories({
    agentDir,
    stateDir,
    logger,
    extraDirectories: ["user-memory"],
  });
  assert.equal(await exists(join(agentDir, "user-memory")), false);
  assert.equal(await readFile(join(stateDir, "user-memory", "owner.md"), "utf8"), "memory");
});
