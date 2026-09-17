import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type {
  PiViewerEvent,
  PiViewerEventKind,
  ViewerSessionDetail,
  ViewerSessionSummary,
} from "../domain/viewer-event";

const FIRST_MESSAGE_MAX_LENGTH = 240;
const EVENT_SUMMARY_MAX_LENGTH = 500;
const DEFAULT_EVENT_LIMIT = 100;

export interface PiSessionQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

interface PiSessionCursor {
  readonly sessionId: string;
  readonly beforeEntryId: string;
}

export class PiSessionReader {
  constructor(private readonly agentDirectory: string) {}

  async list(): Promise<ViewerSessionSummary[]> {
    const sessionDirectories = await this.listSessionDirectories();
    const sessions: ViewerSessionSummary[] = [];

    for (const { channelKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      sessions.push(...infos.map((info) => toSessionSummary(info, channelKey)));
    }

    return sessions.sort((left, right) => right.modified.localeCompare(left.modified));
  }

  async get(
    sessionId: string,
    query: PiSessionQuery = {},
  ): Promise<ViewerSessionDetail | undefined> {
    const session = await this.findSession(sessionId);
    if (!session) return undefined;

    const entries = parseSessionEntries(await readFile(session.info.path, "utf8"));
    const header = entries.find((entry): entry is Extract<FileEntry, { type: "session" }> => {
      return entry.type === "session";
    });
    if (!header || header.id !== sessionId) return undefined;

    const sessionEntries = entries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor, sessionId) : undefined;
    const endIndex = cursor
      ? sessionEntries.findIndex((entry) => entry.id === cursor.beforeEntryId)
      : sessionEntries.length;
    if (cursor && endIndex < 0) throw new Error("Unknown session cursor entry");

    const pageEnd = cursor ? endIndex + 1 : sessionEntries.length;
    const pageStart = Math.max(0, pageEnd - limit);
    const pageEntries = sessionEntries.slice(pageStart, pageEnd);

    return {
      session: toSessionSummary(session.info, session.channelKey),
      items: pageEntries.map((entry) => toViewerEvent(entry, sessionId)),
      nextCursor:
        pageStart > 0
          ? encodeCursor({ sessionId, beforeEntryId: sessionEntries[pageStart - 1]?.id ?? "" })
          : null,
    };
  }

  private async findSession(
    sessionId: string,
  ): Promise<{ readonly channelKey: string; readonly info: SessionInfo } | undefined> {
    const sessionDirectories = await this.listSessionDirectories();

    for (const { channelKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      const info = infos.find((candidate) => candidate.id === sessionId);
      if (info) return { channelKey, info };
    }

    return undefined;
  }

  private async listSessionDirectories(): Promise<
    { readonly channelKey: string; readonly directory: string }[]
  > {
    const sessionsDirectory = resolve(this.agentDirectory, "sessions");

    let entries;
    try {
      entries = await readdir(sessionsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const channelKey = decodeChannelKey(entry.name);
        return channelKey === undefined
          ? []
          : [{ channelKey, directory: resolve(sessionsDirectory, entry.name) }];
      });
  }
}

function toSessionSummary(info: SessionInfo, channelKey: string): ViewerSessionSummary {
  return {
    id: info.id,
    channelKey,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: truncate(info.firstMessage, FIRST_MESSAGE_MAX_LENGTH),
  };
}

function toViewerEvent(entry: SessionEntry, sessionId: string): PiViewerEvent {
  const base = {
    source: "pi" as const,
    id: entry.id,
    timestamp: entry.timestamp,
    sessionId,
    kind: entry.type as PiViewerEventKind,
    parentId: entry.parentId,
  };

  switch (entry.type) {
    case "message": {
      const content = "content" in entry.message ? entry.message.content : undefined;
      const errorMessage =
        "errorMessage" in entry.message && typeof entry.message.errorMessage === "string"
          ? entry.message.errorMessage
          : undefined;
      return {
        ...base,
        role: entry.message.role,
        summary: truncate(
          errorMessage ? `Error: ${errorMessage}` : extractText(content),
          EVENT_SUMMARY_MAX_LENGTH,
        ),
        errorMessage,
        content: sanitizeContent(content),
      };
    }
    case "thinking_level_change":
      return { ...base, summary: entry.thinkingLevel, content: entry.thinkingLevel };
    case "model_change":
      return {
        ...base,
        summary: `${entry.provider}/${entry.modelId}`,
        content: { provider: entry.provider, modelId: entry.modelId },
      };
    case "compaction":
      return {
        ...base,
        summary: truncate(entry.summary, EVENT_SUMMARY_MAX_LENGTH),
        content: entry.summary,
      };
    case "branch_summary":
      return {
        ...base,
        summary: truncate(entry.summary, EVENT_SUMMARY_MAX_LENGTH),
        content: entry.summary,
      };
    case "custom":
      return {
        ...base,
        summary: entry.customType,
        content: { customType: entry.customType, data: sanitizeContent(entry.data) },
      };
    case "custom_message":
      return {
        ...base,
        summary: entry.customType,
        content: sanitizeContent(entry.content),
      };
    case "label":
      return {
        ...base,
        summary: entry.label ?? "",
        content: { targetId: entry.targetId, label: entry.label },
      };
    case "session_info":
      return { ...base, summary: entry.name ?? "", content: entry.name };
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(isRecord)
    .filter((block) => block.type === "text" || block.type === "thinking")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function sanitizeContent(content: unknown): unknown {
  if (Array.isArray(content)) return content.map((item) => sanitizeContent(item));
  if (!isRecord(content)) return content;

  if (content.type === "image" && "data" in content) {
    const { data: _data, ...withoutImageData } = content;
    return { ...withoutImageData, omitted: true };
  }

  return Object.fromEntries(
    Object.entries(content).map(([key, value]) => [key, sanitizeContent(value)]),
  );
}

function decodeChannelKey(directoryName: string): string | undefined {
  try {
    return decodeURIComponent(directoryName);
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function encodeCursor(cursor: PiSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, sessionId: string): PiSessionCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid session cursor");
  }

  if (
    !isRecord(decoded) ||
    decoded.sessionId !== sessionId ||
    typeof decoded.beforeEntryId !== "string" ||
    decoded.beforeEntryId.length === 0
  ) {
    throw new Error("Invalid session cursor");
  }

  return { beforeEntryId: decoded.beforeEntryId, sessionId: decoded.sessionId };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("Session event limit must be an integer between 1 and 200");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
