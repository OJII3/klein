import { readFile } from "node:fs/promises";

import {
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type { ViewerPage, ViewerSessionDetail, ViewerSessionSummary } from "../domain/viewer-event";
import type {
  ChannelNameReader,
  ViewerSessionQuery,
  ViewerSessionReader,
} from "../ports/viewer-readers";
import {
  decodeSessionCursor,
  decodeSessionListCursor,
  encodeSessionCursor,
  encodeSessionListCursor,
  normalizeSessionLimit,
} from "./pi-session-cursor";
import { toViewerEvent, toViewerSessionSummary } from "./pi-session-event-mapper";
import { listPiSessionDirectories } from "./pi-session-files";

export class PiSessionReader implements ViewerSessionReader {
  constructor(
    private readonly agentDirectory: string,
    private readonly channelNames?: ChannelNameReader,
  ) {}

  async list(query: ViewerSessionQuery = {}): Promise<ViewerPage<ViewerSessionSummary>> {
    const [sessionDirectories, channelNames] = await Promise.all([
      listPiSessionDirectories(this.agentDirectory),
      this.channelNames?.read(),
    ]);
    const sessions: ViewerSessionSummary[] = [];

    for (const { channelKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      sessions.push(...infos.map((info) => toViewerSessionSummary(info, channelKey, channelNames)));
    }

    sessions.sort(
      (left, right) =>
        right.modified.localeCompare(left.modified) || right.id.localeCompare(left.id),
    );

    const limit = normalizeSessionLimit(query.limit);
    const cursor = query.cursor ? decodeSessionListCursor(query.cursor) : undefined;
    const pageStart = cursor
      ? sessions.findIndex((session) => session.id === cursor.beforeSessionId) + 1
      : 0;
    if (cursor && pageStart === 0) throw new Error("Unknown session list cursor session");

    const pageEnd = Math.min(sessions.length, pageStart + limit);
    const pageItems = sessions.slice(pageStart, pageEnd);

    return {
      items: pageItems,
      nextCursor:
        pageEnd < sessions.length
          ? encodeSessionListCursor({ beforeSessionId: pageItems.at(-1)?.id ?? "" })
          : null,
    };
  }

  async get(
    sessionId: string,
    query: ViewerSessionQuery = {},
  ): Promise<ViewerSessionDetail | undefined> {
    const [session, channelNames] = await Promise.all([
      this.findSession(sessionId),
      this.channelNames?.read(),
    ]);
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
      session: toViewerSessionSummary(session.info, session.channelKey, channelNames),
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
    const sessionDirectories = await listPiSessionDirectories(this.agentDirectory);

    for (const { channelKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      const info = infos.find((candidate) => candidate.id === sessionId);
      if (info) return { channelKey, info };
    }

    return undefined;
  }
}
