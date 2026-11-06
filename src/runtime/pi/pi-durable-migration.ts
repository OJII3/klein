import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, utimes } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ChannelSessionStateStore,
  serializeConversationKey,
  type ChannelSessionState,
  type ConversationKey,
} from "@app/channel-session-state-store";

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

interface StoredDocumentRecord {
  readonly id: number;
  readonly kind: string;
  readonly key: string;
  readonly scope: { readonly kind: string };
}

interface StoredRevisionRow {
  readonly seq: number;
  readonly kind: string;
  readonly version: number;
  readonly content: string;
}

interface StoredConversationRecord {
  readonly id: number;
  readonly parent?: {
    readonly conversationId: number;
    readonly at: number;
  };
}

interface StoredEntryRecord {
  readonly id: number;
  readonly conversationId: number;
  readonly head?: number;
  readonly kind: string;
  readonly model?: readonly Record<string, unknown>[];
  readonly data?: unknown;
}

export interface MigratePiDurableStorageOptions {
  readonly agentDir: string;
  readonly cwd?: string;
  readonly sqlitePaths?: readonly string[];
  readonly logger?: Logger;
}

export interface MigratePiDurableStorageResult {
  readonly migratedChannelStates: number;
  readonly migratedConversations: number;
}

export async function migratePiDurableStorage(
  options: MigratePiDurableStorageOptions,
): Promise<MigratePiDurableStorageResult> {
  const agentDir = resolve(options.agentDir);
  const cwd = resolve(options.cwd ?? process.cwd());
  const channelSessionsDir = resolve(agentDir, "channel-sessions");
  const channelStore = new ChannelSessionStateStore(channelSessionsDir);
  const existingChannelStates = new Map<string, ChannelSessionState>(
    (await channelStore.list()).map((state) => [
      serializeConversationKey(state.conversationKey),
      state,
    ]),
  );
  let migratedChannelStates = await migrateLegacyChannelSessionStateFiles(
    resolve(agentDir, "channel-session-state"),
    channelStore,
    existingChannelStates,
  );

  const candidateSqlitePaths = options.sqlitePaths ?? [
    resolve(agentDir, "pi-durable", "pi-durable.sqlite"),
    resolve(agentDir, "pi-durable-voice", "pi-durable.sqlite"),
  ];
  const existingSqlitePaths = candidateSqlitePaths
    .map((path) => resolve(path))
    .filter((path, index, all) => all.indexOf(path) === index && existsSync(path));
  if (existingSqlitePaths.length === 0) {
    return { migratedChannelStates, migratedConversations: 0 };
  }

  let migratedConversations = 0;

  for (const sqlitePath of existingSqlitePaths) {
    try {
      const result = await migrateSingleDatabase({
        sqlitePath,
        agentDir,
        cwd,
        channelStore,
        existingChannelStates,
        logger: options.logger,
      });
      migratedChannelStates += result.migratedChannelStates;
      migratedConversations += result.migratedConversations;
    } catch (error) {
      options.logger?.warn(
        { err: error, event: "pi_durable_migration_failed", sqlitePath },
        "Failed to migrate pi-durable SQLite database",
      );
    }
  }

  return { migratedChannelStates, migratedConversations };
}

async function migrateLegacyChannelSessionStateFiles(
  legacyDir: string,
  channelStore: ChannelSessionStateStore,
  existingChannelStates: Map<string, ChannelSessionState>,
): Promise<number> {
  if (!existsSync(legacyDir)) return 0;
  const entries = await readdir(legacyDir, { withFileTypes: true });
  let migrated = 0;

  for (const file of entries) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    let state: ChannelSessionState | undefined;
    try {
      state = parseChannelSessionState(
        JSON.parse(await readFile(join(legacyDir, file.name), "utf8")),
      );
    } catch {
      continue;
    }
    if (!state) continue;

    const key = serializeConversationKey(state.conversationKey);
    // The SQLite state is newer than these files; never let a stale file win.
    if (existingChannelStates.has(key)) continue;
    await channelStore.save(state);
    existingChannelStates.set(key, state);
    migrated += 1;
  }

  return migrated;
}

async function migrateSingleDatabase(options: {
  readonly sqlitePath: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly channelStore: ChannelSessionStateStore;
  readonly existingChannelStates: Map<string, ChannelSessionState>;
  readonly logger?: Logger;
}): Promise<MigratePiDurableStorageResult> {
  const { sqlitePath, agentDir, cwd, channelStore, existingChannelStates } = options;
  const db = new DatabaseSync(sqlitePath);
  let migratedChannelStates = 0;
  let migratedConversations = 0;

  try {
    if (!hasRequiredTables(db)) {
      return { migratedChannelStates: 0, migratedConversations: 0 };
    }

    const documents = loadSessionDocuments(db);
    for (const doc of documents) {
      if (
        doc.record.kind !== "klein.conversation-state" &&
        doc.record.kind !== "klein.discord-channel-state"
      ) {
        continue;
      }
      const state = parseChannelSessionState(doc.value);
      if (!state) continue;

      const stateKey = serializeConversationKey(state.conversationKey);
      const current = existingChannelStates.get(stateKey);
      if (!current || shouldReplaceChannelState(current, state)) {
        await channelStore.save(state);
        existingChannelStates.set(stateKey, state);
        migratedChannelStates += 1;
      }
    }

    const dbTag = createHash("sha256").update(sqlitePath).digest("hex").slice(0, 12);
    for (const doc of documents) {
      if (doc.record.kind !== "klein.session-conversations") continue;
      const parsed = parseSessionConversations(doc.record.key, doc.value);
      if (!parsed || parsed.conversationIds.length === 0) continue;

      const sessionDir = resolve(agentDir, "sessions", encodeURIComponent(parsed.sessionKey));
      await mkdir(sessionDir, { recursive: true });
      const existingFiles = await findExistingSessionFilesById(sessionDir);
      const sessionFilesInOrder: string[] = [];
      let createdAnyForKey = false;

      for (const conversationId of parsed.conversationIds) {
        const sessionId = `durable-${dbTag}-${conversationId}`;
        const existingFile = existingFiles.get(sessionId);
        if (existingFile) {
          sessionFilesInOrder.push(existingFile);
          continue;
        }

        const entries = loadConversationEntries(db, conversationId);
        const createdFile = writeMigratedSessionFile({
          cwd,
          sessionDir,
          sessionId,
          entries,
        });
        if (createdFile) {
          sessionFilesInOrder.push(createdFile);
          createdAnyForKey = true;
          migratedConversations += 1;
        }
      }

      if (createdAnyForKey && sessionFilesInOrder.length > 1) {
        const baseTimeMs = Date.now() - sessionFilesInOrder.length * 1_000;
        for (const [index, filePath] of sessionFilesInOrder.entries()) {
          const timestamp = new Date(baseTimeMs + index * 1_000);
          await utimes(filePath, timestamp, timestamp);
        }
      }
    }
  } finally {
    db.close();
  }

  if (migratedChannelStates > 0 || migratedConversations > 0) {
    options.logger?.info(
      {
        event: "pi_durable_migration_completed",
        sqlitePath,
        migratedChannelStates,
        migratedConversations,
      },
      "Migrated pi-durable SQLite state to file-backed Pi sessions",
    );
  }

  return { migratedChannelStates, migratedConversations };
}

function hasRequiredTables(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = new Set(rows.map((row) => row.name));
  return (
    names.has("documents") &&
    names.has("document_revisions") &&
    names.has("conversations") &&
    names.has("entries")
  );
}

function loadSessionDocuments(
  db: DatabaseSync,
): Array<{ record: StoredDocumentRecord; value: unknown }> {
  const docRows = db
    .prepare(
      "SELECT id, record FROM documents WHERE scope_kind = 'session' AND owner_id = 0 AND retired_at IS NULL ORDER BY id ASC",
    )
    .all() as Array<{ id: number; record: string }>;
  const revisionStmt = db.prepare(
    "SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq ASC",
  );

  const results: Array<{ record: StoredDocumentRecord; value: unknown }> = [];
  for (const row of docRows) {
    let record: StoredDocumentRecord;
    try {
      record = JSON.parse(row.record) as StoredDocumentRecord;
    } catch {
      continue;
    }
    const revisions = revisionStmt.all(row.id) as unknown as StoredRevisionRow[];
    const value = materializeDocumentValue(revisions);
    if (value === undefined) continue;
    results.push({ record, value });
  }
  return results;
}

function materializeDocumentValue(revisions: readonly StoredRevisionRow[]): unknown {
  let baseIndex = -1;
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    if (revisions[index]?.kind === "base") {
      baseIndex = index;
      break;
    }
  }
  if (baseIndex < 0) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(revisions[baseIndex]!.content);
  } catch {
    return undefined;
  }

  for (let index = baseIndex + 1; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    if (revision.kind !== "delta") continue;
    const ops = JSON.parse(revision.content) as readonly unknown[];
    value = applyDeltaOps(value, ops);
  }
  return value;
}

export function applyDeltaOps(root: unknown, ops: readonly unknown[]): unknown {
  let current = root;
  for (const op of ops) {
    if (!Array.isArray(op) || typeof op[0] !== "string") continue;
    const kind = op[0];
    if (kind === "r") {
      current = op[1];
      continue;
    }
    const path = op[1] as readonly (string | number)[];
    if (!Array.isArray(path)) continue;

    switch (kind) {
      case "p": {
        const target = navigateToTarget(current, path) as unknown[];
        const start = op[2] as number;
        const deleteCount = op[3] as number;
        const items = (op[4] as readonly unknown[]) ?? [];
        target.splice(start, deleteCount, ...items);
        break;
      }
      case "m": {
        const target = navigateToTarget(current, path) as unknown[];
        const perm = op[2] as readonly number[];
        const copy = target.slice();
        for (let index = 0; index < perm.length; index += 1) {
          target[index] = copy[perm[index]!];
        }
        break;
      }
      case "s": {
        const parent = navigateToParent(current, path);
        parent[path[path.length - 1]!] = op[2];
        break;
      }
      case "d": {
        const parent = navigateToParent(current, path);
        delete parent[path[path.length - 1]!];
        break;
      }
      case "a": {
        const suffix = op[2] as string;
        if (path.length === 0) {
          current = (current as string) + suffix;
        } else {
          const parent = navigateToParent(current, path);
          const key = path[path.length - 1]!;
          parent[key] = (parent[key] as string) + suffix;
        }
        break;
      }
      case "t": {
        const trimCount = op[2] as number;
        if (path.length === 0) {
          current = (current as string).slice(trimCount);
        } else {
          const parent = navigateToParent(current, path);
          const key = path[path.length - 1]!;
          parent[key] = (parent[key] as string).slice(trimCount);
        }
        break;
      }
    }
  }
  return current;
}

function navigateToTarget(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

function navigateToParent(
  root: unknown,
  path: readonly (string | number)[],
): Record<string | number, unknown> {
  let node: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    node = (node as Record<string | number, unknown>)[path[index]!];
  }
  return node as Record<string | number, unknown>;
}

function parseConversationKey(
  candidateKey: unknown,
  legacyChannelId: unknown,
): ConversationKey | undefined {
  if (typeof candidateKey === "object" && candidateKey !== null) {
    const keyObj = candidateKey as { kind?: unknown; channelId?: unknown };
    if (
      keyObj.kind === "discord" &&
      typeof keyObj.channelId === "string" &&
      keyObj.channelId.length > 0
    ) {
      return { kind: "discord", channelId: keyObj.channelId };
    }
  }
  if (typeof legacyChannelId === "string" && legacyChannelId.length > 0) {
    return { kind: "discord", channelId: legacyChannelId };
  }
  return undefined;
}

function parseChannelSessionState(value: unknown): ChannelSessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    conversationKey?: unknown;
    channelId?: unknown;
    accessScope?: unknown;
    sessionKey?: unknown;
    lastActivityAt?: unknown;
    lastRotationDate?: unknown;
    hasActivitySinceRotation?: unknown;
    handoffContext?: unknown;
  };
  const conversationKey = parseConversationKey(candidate.conversationKey, candidate.channelId);
  if (
    !conversationKey ||
    typeof candidate.sessionKey !== "string" ||
    (candidate.lastActivityAt !== null && typeof candidate.lastActivityAt !== "number") ||
    typeof candidate.lastRotationDate !== "string" ||
    typeof candidate.hasActivitySinceRotation !== "boolean" ||
    (candidate.accessScope !== undefined &&
      candidate.accessScope !== null &&
      typeof candidate.accessScope !== "string") ||
    (candidate.handoffContext !== undefined &&
      candidate.handoffContext !== null &&
      typeof candidate.handoffContext !== "string")
  ) {
    return undefined;
  }

  return {
    conversationKey,
    ...(typeof candidate.accessScope === "string" ? { accessScope: candidate.accessScope } : {}),
    sessionKey: candidate.sessionKey,
    lastActivityAt: candidate.lastActivityAt,
    lastRotationDate: candidate.lastRotationDate,
    hasActivitySinceRotation: candidate.hasActivitySinceRotation,
    ...(typeof candidate.handoffContext === "string"
      ? { handoffContext: candidate.handoffContext }
      : {}),
  };
}

function shouldReplaceChannelState(
  existing: ChannelSessionState,
  migrated: ChannelSessionState,
): boolean {
  if (existing.lastActivityAt === null && migrated.lastActivityAt !== null) return true;
  if (existing.lastActivityAt !== null && migrated.lastActivityAt !== null) {
    return migrated.lastActivityAt > existing.lastActivityAt;
  }
  return false;
}

function parseSessionConversations(
  docKey: string,
  value: unknown,
): { sessionKey: string; conversationIds: number[] } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    sessionKey?: unknown;
    conversationIds?: unknown;
  };
  const sessionKey =
    typeof candidate.sessionKey === "string" && candidate.sessionKey.length > 0
      ? candidate.sessionKey
      : docKey;
  if (!sessionKey || !Array.isArray(candidate.conversationIds)) return undefined;
  const conversationIds = candidate.conversationIds.filter(
    (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 0,
  );
  return { sessionKey, conversationIds };
}

function loadConversationEntries(db: DatabaseSync, conversationId: number): StoredEntryRecord[] {
  const convStmt = db.prepare("SELECT record FROM conversations WHERE id = ?");
  const entriesStmt = db.prepare(
    "SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC",
  );
  const chain: Array<{ conversationId: number; maxEntryId?: number }> = [];
  const visited = new Set<number>();
  let currentId: number | undefined = conversationId;
  let maxEntryId: number | undefined;

  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    chain.push({ conversationId: currentId, maxEntryId });
    const row = convStmt.get(currentId) as { record: string } | undefined;
    if (!row) break;
    let conv: StoredConversationRecord;
    try {
      conv = JSON.parse(row.record) as StoredConversationRecord;
    } catch {
      break;
    }
    if (conv.parent && typeof conv.parent.conversationId === "number") {
      currentId = conv.parent.conversationId;
      maxEntryId = conv.parent.at;
    } else {
      currentId = undefined;
    }
  }

  chain.reverse();
  const entries: StoredEntryRecord[] = [];
  for (const segment of chain) {
    const rows = entriesStmt.all(segment.conversationId) as Array<{ record: string }>;
    for (const row of rows) {
      let entry: StoredEntryRecord;
      try {
        entry = JSON.parse(row.record) as StoredEntryRecord;
      } catch {
        continue;
      }
      if (segment.maxEntryId !== undefined && entry.id > segment.maxEntryId) continue;
      entries.push(entry);
    }
  }
  return entries;
}

function writeMigratedSessionFile(options: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly entries: readonly StoredEntryRecord[];
}): string | undefined {
  const { cwd, sessionDir, sessionId, entries } = options;
  if (entries.length === 0) return undefined;

  let startIndex = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "pi.reset") {
      startIndex = index;
      break;
    }
  }

  const activeEntries = entries.slice(startIndex);
  const sessionManager = SessionManager.create(cwd, sessionDir);
  sessionManager.newSession({ id: sessionId });
  const entryIdMap = new Map<number, string>();
  let appendedCount = 0;

  for (const entry of activeEntries) {
    if (entry.kind.startsWith("klein.legacy.")) continue;
    if (entry.kind === "pi.compaction") {
      const summary = extractCompactionSummary(entry.model?.[0]);
      const firstKeptEntryId =
        typeof entry.head === "number" && entry.head !== entry.id
          ? entryIdMap.get(entry.head)
          : undefined;
      const compactionEntryId = sessionManager.appendCompaction(
        summary,
        firstKeptEntryId as never,
        0,
      );
      entryIdMap.set(entry.id, compactionEntryId);
      appendedCount += 1;
      continue;
    }

    for (const message of entry.model ?? []) {
      if (typeof message !== "object" || message === null || !("role" in message)) continue;
      const appendedId = sessionManager.appendMessage(message as never);
      if (!entryIdMap.has(entry.id)) {
        entryIdMap.set(entry.id, appendedId);
      }
      appendedCount += 1;
    }
  }

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  if (appendedCount === 0 || !existsSync(sessionFile)) {
    const internal = sessionManager as unknown as {
      _rewriteFile?: () => void;
      flushed?: boolean;
    };
    internal._rewriteFile?.();
    internal.flushed = true;
  }
  return existsSync(sessionFile) ? sessionFile : undefined;
}

function extractCompactionSummary(message: Record<string, unknown> | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: string; text?: string } =>
                typeof block === "object" && block !== null && "type" in block,
            )
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n")
        : "";
  if (raw.startsWith(SUMMARY_PREFIX) && raw.endsWith(SUMMARY_SUFFIX)) {
    return raw.slice(SUMMARY_PREFIX.length, raw.length - SUMMARY_SUFFIX.length);
  }
  return raw;
}

async function findExistingSessionFilesById(sessionDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!existsSync(sessionDir)) return map;
  const entries = await readdir(sessionDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const match = /^.+_([A-Za-z0-9._-]+)\.jsonl$/.exec(basename(entry.name));
    if (match?.[1]) {
      map.set(match[1], join(sessionDir, entry.name));
    }
  }
  return map;
}
