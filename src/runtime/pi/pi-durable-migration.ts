import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, utimes } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  JsonValue,
  StopReason,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ChannelSessionStateStore,
  serializeConversationKey,
  type ChannelSessionState,
  type ConversationKey,
} from "@app/channel-session-state-store";
import { isRecord, parseJson } from "@shared/type-guards";

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

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
  const existingSqlitePaths = [
    ...new Set(candidateSqlitePaths.map((path) => resolve(path))),
  ].filter((path) => existsSync(path));
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
        parseJson(await readFile(join(legacyDir, file.name), "utf8")),
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

      const sessionDir = resolve(
        agentDir,
        "sessions",
        "conversation",
        encodeURIComponent(parsed.sessionKey),
      );
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
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") {
      names.add(row.name);
    }
  }
  return (
    names.has("documents") &&
    names.has("document_revisions") &&
    names.has("conversations") &&
    names.has("entries")
  );
}

function isStoredDocumentRecord(value: unknown): value is StoredDocumentRecord {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.kind === "string" &&
    typeof value.key === "string" &&
    isRecord(value.scope) &&
    typeof value.scope.kind === "string"
  );
}

function toStoredRevisionRow(row: Record<string, unknown>): StoredRevisionRow | undefined {
  if (
    typeof row.seq === "number" &&
    typeof row.kind === "string" &&
    typeof row.version === "number" &&
    typeof row.content === "string"
  ) {
    return {
      seq: row.seq,
      kind: row.kind,
      version: row.version,
      content: row.content,
    };
  }
  return undefined;
}

function loadSessionDocuments(
  db: DatabaseSync,
): Array<{ record: StoredDocumentRecord; value: unknown }> {
  const docRows = db
    .prepare(
      "SELECT id, record FROM documents WHERE scope_kind = 'session' AND owner_id = 0 AND retired_at IS NULL ORDER BY id ASC",
    )
    .all();
  const revisionStmt = db.prepare(
    "SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq ASC",
  );

  const results: Array<{ record: StoredDocumentRecord; value: unknown }> = [];
  for (const row of docRows) {
    if (typeof row.id !== "number" || typeof row.record !== "string") continue;
    let parsedRecord: unknown;
    try {
      parsedRecord = parseJson(row.record);
    } catch {
      continue;
    }
    if (!isStoredDocumentRecord(parsedRecord)) continue;

    const rawRevisions = revisionStmt.all(row.id);
    const revisions: StoredRevisionRow[] = [];
    for (const rawRevision of rawRevisions) {
      const revision = toStoredRevisionRow(rawRevision);
      if (revision) {
        revisions.push(revision);
      }
    }
    const value = materializeDocumentValue(revisions);
    if (value === undefined) continue;
    results.push({ record: parsedRecord, value });
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
  const baseRevision = baseIndex >= 0 ? revisions[baseIndex] : undefined;
  if (!baseRevision) return undefined;

  let value: unknown;
  try {
    value = parseJson(baseRevision.content);
  } catch {
    return undefined;
  }

  for (let index = baseIndex + 1; index < revisions.length; index += 1) {
    const revision = revisions[index];
    if (!revision || revision.kind !== "delta") continue;
    const ops = parseJson(revision.content);
    if (!Array.isArray(ops)) continue;
    value = applyDeltaOps(value, ops);
  }
  return value;
}

type DeltaPathSegment = string | number;
type DeltaContainer = Record<string, unknown> | unknown[];

function isMutableArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isDeltaPath(value: unknown): value is readonly DeltaPathSegment[] {
  return (
    isMutableArray(value) &&
    value.every((segment) => typeof segment === "string" || typeof segment === "number")
  );
}

function isDeltaContainer(value: unknown): value is DeltaContainer {
  return isMutableArray(value) || isRecord(value);
}

function readContainerSlot(container: DeltaContainer, segment: DeltaPathSegment): unknown {
  if (isMutableArray(container)) {
    return typeof segment === "number" ? container[segment] : undefined;
  }
  return container[String(segment)];
}

function writeContainerSlot(
  container: DeltaContainer,
  segment: DeltaPathSegment,
  value: unknown,
): void {
  if (isMutableArray(container)) {
    if (typeof segment === "number") {
      container[segment] = value;
    }
    return;
  }
  container[String(segment)] = value;
}

function deleteContainerSlot(container: DeltaContainer, segment: DeltaPathSegment): void {
  if (isMutableArray(container)) {
    if (typeof segment === "number") {
      Reflect.deleteProperty(container, segment);
    }
    return;
  }
  delete container[String(segment)];
}

export function applyDeltaOps(root: unknown, ops: readonly unknown[]): unknown {
  let current = root;
  for (const op of ops) {
    if (!isMutableArray(op) || typeof op[0] !== "string") continue;
    const kind = op[0];
    if (kind === "r") {
      current = op[1];
      continue;
    }
    const path: unknown = op[1];
    if (!isDeltaPath(path)) continue;

    switch (kind) {
      case "p": {
        const target = navigateToTarget(current, path);
        const start: unknown = op[2];
        const deleteCount: unknown = op[3];
        if (
          !isMutableArray(target) ||
          typeof start !== "number" ||
          typeof deleteCount !== "number"
        ) {
          break;
        }
        const items: readonly unknown[] = isMutableArray(op[4]) ? op[4] : [];
        target.splice(start, deleteCount, ...items);
        break;
      }
      case "m": {
        const target = navigateToTarget(current, path);
        const perm: unknown = op[2];
        if (!isMutableArray(target) || !isMutableArray(perm)) break;
        const copy = target.slice();
        for (let index = 0; index < perm.length; index += 1) {
          const sourceIndex: unknown = perm[index];
          if (typeof sourceIndex === "number") {
            target[index] = copy[sourceIndex];
          }
        }
        break;
      }
      case "s": {
        const key = path.at(-1);
        const parent = key !== undefined ? navigateToParent(current, path) : undefined;
        if (parent && key !== undefined) {
          writeContainerSlot(parent, key, op[2]);
        }
        break;
      }
      case "d": {
        const key = path.at(-1);
        const parent = key !== undefined ? navigateToParent(current, path) : undefined;
        if (parent && key !== undefined) {
          deleteContainerSlot(parent, key);
        }
        break;
      }
      case "a": {
        const suffix: unknown = op[2];
        if (typeof suffix !== "string") break;
        if (path.length === 0) {
          if (typeof current === "string") {
            current = current + suffix;
          }
        } else {
          const key = path.at(-1);
          const parent = key !== undefined ? navigateToParent(current, path) : undefined;
          if (parent && key !== undefined) {
            const existing = readContainerSlot(parent, key);
            if (typeof existing === "string") {
              writeContainerSlot(parent, key, existing + suffix);
            }
          }
        }
        break;
      }
      case "t": {
        const trimCount: unknown = op[2];
        if (typeof trimCount !== "number") break;
        if (path.length === 0) {
          if (typeof current === "string") {
            current = current.slice(trimCount);
          }
        } else {
          const key = path.at(-1);
          const parent = key !== undefined ? navigateToParent(current, path) : undefined;
          if (parent && key !== undefined) {
            const existing = readContainerSlot(parent, key);
            if (typeof existing === "string") {
              writeContainerSlot(parent, key, existing.slice(trimCount));
            }
          }
        }
        break;
      }
    }
  }
  return current;
}

function navigateToTarget(root: unknown, path: readonly DeltaPathSegment[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (!isDeltaContainer(node)) return undefined;
    node = readContainerSlot(node, segment);
  }
  return node;
}

function navigateToParent(
  root: unknown,
  path: readonly DeltaPathSegment[],
): DeltaContainer | undefined {
  let node: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined || !isDeltaContainer(node)) return undefined;
    node = readContainerSlot(node, segment);
  }
  return isDeltaContainer(node) ? node : undefined;
}

function parseConversationKey(
  candidateKey: unknown,
  legacyChannelId: unknown,
): ConversationKey | undefined {
  if (
    isRecord(candidateKey) &&
    candidateKey.kind === "discord" &&
    typeof candidateKey.channelId === "string" &&
    candidateKey.channelId.length > 0
  ) {
    return { kind: "discord", channelId: candidateKey.channelId };
  }
  if (typeof legacyChannelId === "string" && legacyChannelId.length > 0) {
    return { kind: "discord", channelId: legacyChannelId };
  }
  return undefined;
}

function parseChannelSessionState(value: unknown): ChannelSessionState | undefined {
  if (!isRecord(value)) return undefined;
  const conversationKey = parseConversationKey(value.conversationKey, value.channelId);
  if (
    !conversationKey ||
    typeof value.sessionKey !== "string" ||
    (value.lastActivityAt !== null && typeof value.lastActivityAt !== "number") ||
    typeof value.lastRotationDate !== "string" ||
    typeof value.hasActivitySinceRotation !== "boolean" ||
    (value.accessScope !== undefined &&
      value.accessScope !== null &&
      typeof value.accessScope !== "string") ||
    (value.handoffContext !== undefined &&
      value.handoffContext !== null &&
      typeof value.handoffContext !== "string")
  ) {
    return undefined;
  }

  return {
    conversationKey,
    ...(typeof value.accessScope === "string" ? { accessScope: value.accessScope } : {}),
    sessionKey: value.sessionKey,
    lastActivityAt: value.lastActivityAt,
    lastRotationDate: value.lastRotationDate,
    hasActivitySinceRotation: value.hasActivitySinceRotation,
    ...(typeof value.handoffContext === "string" ? { handoffContext: value.handoffContext } : {}),
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
  if (!isRecord(value)) return undefined;
  const sessionKey =
    typeof value.sessionKey === "string" && value.sessionKey.length > 0 ? value.sessionKey : docKey;
  if (!sessionKey || !Array.isArray(value.conversationIds)) return undefined;
  const conversationIds = value.conversationIds.filter(
    (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 0,
  );
  return { sessionKey, conversationIds };
}

function parseStoredConversationRecord(value: unknown): StoredConversationRecord | undefined {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  if (value.parent === undefined) {
    return { id: value.id };
  }
  if (
    isRecord(value.parent) &&
    typeof value.parent.conversationId === "number" &&
    typeof value.parent.at === "number"
  ) {
    return {
      id: value.id,
      parent: {
        conversationId: value.parent.conversationId,
        at: value.parent.at,
      },
    };
  }
  return { id: value.id };
}

function parseStoredEntryRecord(value: unknown): StoredEntryRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.conversationId !== "number" ||
    typeof value.kind !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    conversationId: value.conversationId,
    ...(typeof value.head === "number" ? { head: value.head } : {}),
    kind: value.kind,
    ...(Array.isArray(value.model) ? { model: value.model.filter(isRecord) } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
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
    const row = convStmt.get(currentId);
    if (!row || typeof row.record !== "string") break;
    let parsedConv: unknown;
    try {
      parsedConv = parseJson(row.record);
    } catch {
      break;
    }
    const conv = parseStoredConversationRecord(parsedConv);
    if (!conv) break;
    if (conv.parent) {
      currentId = conv.parent.conversationId;
      maxEntryId = conv.parent.at;
    } else {
      currentId = undefined;
    }
  }

  chain.reverse();
  const entries: StoredEntryRecord[] = [];
  for (const segment of chain) {
    const rows = entriesStmt.all(segment.conversationId);
    for (const row of rows) {
      if (typeof row.record !== "string") continue;
      let parsedEntry: unknown;
      try {
        parsedEntry = parseJson(row.record);
      } catch {
        continue;
      }
      const entry = parseStoredEntryRecord(parsedEntry);
      if (!entry) continue;
      if (segment.maxEntryId !== undefined && entry.id > segment.maxEntryId) continue;
      entries.push(entry);
    }
  }
  return entries;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (isMutableArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}

function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (isJsonValue(item)) {
      result[key] = item;
    }
  }
  return result;
}

function isTextContent(value: unknown): value is TextContent {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    (value.textSignature === undefined || typeof value.textSignature === "string")
  );
}

function isImageContent(value: unknown): value is ImageContent {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function isThinkingContent(value: unknown): value is ThinkingContent {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    typeof value.thinking === "string" &&
    (value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") &&
    (value.redacted === undefined || typeof value.redacted === "boolean")
  );
}

function parseToolCall(value: unknown): ToolCall | undefined {
  if (
    !isRecord(value) ||
    value.type !== "toolCall" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    return undefined;
  }
  return {
    type: "toolCall",
    id: value.id,
    name: value.name,
    arguments: toJsonObject(value.arguments),
    ...(typeof value.thoughtSignature === "string"
      ? { thoughtSignature: value.thoughtSignature }
      : {}),
    ...(typeof value.namespace === "string" ? { namespace: value.namespace } : {}),
    ...(typeof value.argumentsError === "string" ? { argumentsError: value.argumentsError } : {}),
  };
}

function parseUsage(value: unknown): Usage {
  if (
    isRecord(value) &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number" &&
    typeof value.totalTokens === "number" &&
    isRecord(value.cost) &&
    typeof value.cost.input === "number" &&
    typeof value.cost.output === "number" &&
    typeof value.cost.cacheRead === "number" &&
    typeof value.cost.cacheWrite === "number" &&
    typeof value.cost.total === "number"
  ) {
    return {
      input: value.input,
      output: value.output,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      ...(typeof value.cacheWrite1h === "number" ? { cacheWrite1h: value.cacheWrite1h } : {}),
      ...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}),
      totalTokens: value.totalTokens,
      cost: {
        input: value.cost.input,
        output: value.cost.output,
        cacheRead: value.cost.cacheRead,
        cacheWrite: value.cost.cacheWrite,
        total: value.cost.total,
        ...(typeof value.cost.totalFromProvider === "boolean"
          ? { totalFromProvider: value.cost.totalFromProvider }
          : {}),
      },
    };
  }
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseStopReason(value: unknown): StopReason {
  switch (value) {
    case "pending":
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
    case "deferred":
      return value;
    default:
      return "stop";
  }
}

function parseTextOrImageArray(value: unknown): (TextContent | ImageContent)[] | undefined {
  if (!isMutableArray(value)) return undefined;
  const items: (TextContent | ImageContent)[] = [];
  for (const item of value) {
    if (isTextContent(item) || isImageContent(item)) {
      items.push(item);
    }
  }
  return items;
}

function parseAppendableMessage(value: Record<string, unknown>): AppendableMessage | undefined {
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : 0;

  if (value.role === "user") {
    const content =
      typeof value.content === "string" ? value.content : parseTextOrImageArray(value.content);
    if (content === undefined) return undefined;
    const message: UserMessage = { role: "user", content, timestamp };
    return message;
  }

  if (value.role === "assistant") {
    const content: (TextContent | ThinkingContent | ToolCall)[] = [];
    if (isMutableArray(value.content)) {
      for (const block of value.content) {
        if (isTextContent(block) || isThinkingContent(block)) {
          content.push(block);
          continue;
        }
        const toolCall = parseToolCall(block);
        if (toolCall) {
          content.push(toolCall);
        }
      }
    }
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: typeof value.api === "string" ? value.api : "",
      provider: typeof value.provider === "string" ? value.provider : "",
      model: typeof value.model === "string" ? value.model : "",
      ...(typeof value.responseModel === "string" ? { responseModel: value.responseModel } : {}),
      ...(typeof value.responseId === "string" ? { responseId: value.responseId } : {}),
      ...(typeof value.providerThinkingLevel === "string"
        ? { providerThinkingLevel: value.providerThinkingLevel }
        : {}),
      usage: parseUsage(value.usage),
      stopReason: parseStopReason(value.stopReason),
      ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
      ...(typeof value.rawStopReason === "string" ? { rawStopReason: value.rawStopReason } : {}),
      ...(typeof value.endTurn === "boolean" ? { endTurn: value.endTurn } : {}),
      timestamp,
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    };
    return message;
  }

  if (value.role === "toolResult") {
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") {
      return undefined;
    }
    const content = parseTextOrImageArray(value.content) ?? [];
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      content,
      ...(isJsonValue(value.details) ? { details: value.details } : {}),
      isError: typeof value.isError === "boolean" ? value.isError : false,
      timestamp,
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    };
    return message;
  }

  if (value.role === "system") {
    const content =
      typeof value.content === "string"
        ? value.content
        : isMutableArray(value.content)
          ? value.content.filter((item): item is TextContent => isTextContent(item))
          : undefined;
    if (content === undefined) return undefined;
    const message: SystemMessage = {
      role: "system",
      content,
      timestamp,
    };
    return message;
  }

  if (value.role === "custom") {
    if (typeof value.customType !== "string") return undefined;
    const content =
      typeof value.content === "string" ? value.content : parseTextOrImageArray(value.content);
    if (content === undefined) return undefined;
    const message: Extract<AppendableMessage, { role: "custom" }> = {
      role: "custom",
      customType: value.customType,
      content,
      display: typeof value.display === "boolean" ? value.display : true,
      ...(value.details !== undefined ? { details: value.details } : {}),
      timestamp,
    };
    return message;
  }

  if (value.role === "bashExecution") {
    if (typeof value.command !== "string" || typeof value.output !== "string") return undefined;
    const message: Extract<AppendableMessage, { role: "bashExecution" }> = {
      role: "bashExecution",
      command: value.command,
      output: value.output,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
      cancelled: typeof value.cancelled === "boolean" ? value.cancelled : false,
      truncated: typeof value.truncated === "boolean" ? value.truncated : false,
      ...(typeof value.fullOutputPath === "string" ? { fullOutputPath: value.fullOutputPath } : {}),
      timestamp,
      ...(typeof value.excludeFromContext === "boolean"
        ? { excludeFromContext: value.excludeFromContext }
        : {}),
    };
    return message;
  }

  return undefined;
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
        firstKeptEntryId ?? null,
        0,
      );
      entryIdMap.set(entry.id, compactionEntryId);
      appendedCount += 1;
      continue;
    }

    for (const rawMessage of entry.model ?? []) {
      const message = parseAppendableMessage(rawMessage);
      if (!message) continue;
      const appendedId = sessionManager.appendMessage(message);
      if (!entryIdMap.has(entry.id)) {
        entryIdMap.set(entry.id, appendedId);
      }
      appendedCount += 1;
    }
  }

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  if (appendedCount === 0 || !existsSync(sessionFile)) {
    const header = sessionManager.getHeader();
    const serialized = [...(header ? [header] : []), ...sessionManager.getEntries()]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join("");
    writeFileSync(sessionFile, serialized, "utf8");
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
                isRecord(block) && typeof block.type === "string",
            )
            .filter((block) => block.type === "text")
            .map((block) => (typeof block.text === "string" ? block.text : ""))
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
