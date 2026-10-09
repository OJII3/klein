import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type { ViewerPage, ViewerSessionDetail, ViewerSessionSummary } from "../domain/viewer-event";
import type { ViewerSessionQuery, ViewerSessionReader } from "../ports/viewer-readers";
import {
  decodeSessionCursor,
  decodeSessionListCursor,
  encodeSessionCursor,
  encodeSessionListCursor,
  normalizeSessionLimit,
} from "./pi-session-cursor";
import { toViewerEvent, toViewerSessionSummary } from "./pi-session-event-mapper";

export class PiSessionReader implements ViewerSessionReader {
  constructor(private readonly agentDirectory: string) {}

  async list(query: ViewerSessionQuery = {}): Promise<ViewerPage<ViewerSessionSummary>> {
    const sessionDirectories = await this.listSessionDirectories();
    const sessions: ViewerSessionSummary[] = [];

    for (const { channelKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      sessions.push(...infos.map((info) => toViewerSessionSummary(info, channelKey)));
    }

    sessions.sort((left, right) => right.modified.localeCompare(left.modified));

    const limit = normalizeSessionLimit(query.limit);
    const cursor = query.cursor ? decodeSessionListCursor(query.cursor) : undefined;
    const endIndex = cursor
      ? sessions.findIndex((session) => session.id === cursor.beforeSessionId)
      : sessions.length;
    if (cursor && endIndex < 0) throw new Error("Unknown session list cursor session");

    const pageEnd = cursor ? endIndex + 1 : sessions.length;
    const pageStart = Math.max(0, pageEnd - limit);

    return {
      items: sessions.slice(pageStart, pageEnd),
      nextCursor:
        pageStart > 0
          ? encodeSessionListCursor({ beforeSessionId: sessions[pageStart - 1]?.id ?? "" })
          : null,
    };
  }

  async get(
    sessionId: string,
    query: ViewerSessionQuery = {},
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
    const limit = normalizeSessionLimit(query.limit);
    const cursor = query.cursor ? decodeSessionCursor(query.cursor, sessionId) : undefined;
    const endIndex = cursor
      ? sessionEntries.findIndex((entry) => entry.id === cursor.beforeEntryId)
      : sessionEntries.length;
    if (cursor && endIndex < 0) throw new Error("Unknown session cursor entry");

    const pageEnd = cursor ? endIndex + 1 : sessionEntries.length;
    const pageStart = Math.max(0, pageEnd - limit);
    const pageEntries = sessionEntries.slice(pageStart, pageEnd);

    return {
      session: toViewerSessionSummary(session.info, session.channelKey),
      items: pageEntries.map((entry) => toViewerEvent(entry, sessionId)),
      nextCursor:
        pageStart > 0
          ? encodeSessionCursor({
              sessionId,
              beforeEntryId: sessionEntries[pageStart - 1]?.id ?? "",
            })
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

function decodeChannelKey(directoryName: string): string | undefined {
  try {
    return decodeURIComponent(directoryName);
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
