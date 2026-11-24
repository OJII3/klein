import { readFile } from "node:fs/promises";

import {
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type {
  DiscordNameReader,
  ViewerPage,
  ViewerSessionAgentRole,
  ViewerSessionDetail,
  ViewerSessionQuery,
  ViewerSessionReader,
  ViewerSessionSummary,
} from "@klein/webui-api";
import {
  decodeSessionCursor,
  decodeSessionListCursor,
  encodeSessionCursor,
  encodeSessionListCursor,
  normalizeSessionLimit,
} from "./pi-session-cursor";
import { toViewerEvent, toViewerSessionSummary } from "./pi-session-event-mapper";
import { listViewableSessionDirectories } from "./pi-session-files";

export class PiSessionReader implements ViewerSessionReader {
  constructor(
    private readonly agentDirectory: string,
    private readonly channelNames?: DiscordNameReader,
  ) {}

  async list(query: ViewerSessionQuery = {}): Promise<ViewerPage<ViewerSessionSummary>> {
    const [sessionDirectories, channelNames] = await Promise.all([
      listViewableSessionDirectories(this.agentDirectory),
      this.channelNames?.read(),
    ]);
    const sessions: ViewerSessionSummary[] = [];

    for (const { agentRole, sessionKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      sessions.push(
        ...infos.map((info) => toViewerSessionSummary(info, sessionKey, agentRole, channelNames)),
      );
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
      session: toViewerSessionSummary(
        session.info,
        session.sessionKey,
        session.agentRole,
        channelNames,
      ),
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

  private async findSession(sessionId: string): Promise<
    | {
        readonly agentRole: ViewerSessionAgentRole;
        readonly sessionKey: string;
        readonly info: SessionInfo;
      }
    | undefined
  > {
    const sessionDirectories = await listViewableSessionDirectories(this.agentDirectory);

    for (const { agentRole, sessionKey, directory } of sessionDirectories) {
      const infos = await SessionManager.listAll(directory);
      const info = infos.find((candidate) => candidate.id === sessionId);
      if (info) return { agentRole, sessionKey, info };
    }

    return undefined;
  }
}
