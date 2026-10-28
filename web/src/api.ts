import { treaty } from "@elysia/eden";

import type { WebUiApp } from "@klein/webui/infrastructure/elysia-webui-app";

export interface PinoLog {
  source: "pino";
  id: string;
  timestamp: string;
  level: number | string;
  kind: string;
  summary: string;
  attributes: Record<string, unknown>;
}

export interface LogsResponse {
  items: PinoLog[];
  nextCursor: string | null;
}

export interface LogsQuery {
  limit?: number;
  cursor?: string;
  level?: string;
  q?: string;
  channelId?: string;
  event?: string;
}

export interface SessionSummary {
  id: string;
  channelKey: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionsResponse {
  items: SessionSummary[];
  nextCursor: string | null;
}

export interface PiSessionEvent {
  source: "pi";
  id: string;
  timestamp: string;
  sessionId: string;
  kind: string;
  role?: string;
  parentId?: string | null;
  errorMessage?: string;
  content?: unknown;
}

export interface SessionDetailResponse {
  session: SessionSummary;
  items: PiSessionEvent[];
  nextCursor: string | null;
}

export interface SessionQuery {
  limit?: number;
  cursor?: string;
}

export type MemoryKind = "fact" | "rule" | "decision" | "procedure" | "temporary";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  sourceMessageIds: string[];
}

export type MemoryScope = { type: "owner" } | { type: "guild"; guildId: string };

export interface MemoryScopeSummary {
  scope: MemoryScope;
  entryCount: number;
  updatedAt: string | null;
}

export interface MemoryScopesResponse {
  enabled: boolean;
  items: MemoryScopeSummary[];
}

export interface MemoryDetailResponse {
  scope: MemoryScope;
  entries: MemoryEntry[];
}

const apiOrigin = typeof window === "undefined" ? "http://127.0.0.1:4310" : window.location.origin;

const client = treaty<WebUiApp>(apiOrigin);

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if ("value" in error) {
      const value = errorMessage(error.value);
      if (value !== "APIリクエストに失敗しました") return value;
    }
    if ("error" in error) {
      const value = errorMessage(error.error);
      if (value !== "APIリクエストに失敗しました") return value;
    }
    if ("message" in error && typeof error.message === "string") return error.message;
  }
  return "APIリクエストに失敗しました";
}

async function unwrap<T>(request: Promise<unknown>): Promise<T> {
  const response = (await request) as { data?: unknown; error?: unknown };
  if (response.error) throw new Error(errorMessage(response.error));
  if (response.data === undefined) throw new Error("APIレスポンスが空です");
  return response.data as T;
}

function withoutEmptyValues<T extends object>(query: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ""),
  ) as Partial<T>;
}

export function listLogs(query: LogsQuery = {}): Promise<LogsResponse> {
  return unwrap<LogsResponse>(
    client.api.logs.get({ query: withoutEmptyValues({ limit: 100, ...query }) }),
  );
}

export function listSessions(query: SessionQuery = {}): Promise<SessionsResponse> {
  return unwrap<SessionsResponse>(
    client.api.sessions.get({ query: withoutEmptyValues({ limit: 100, ...query }) }),
  );
}

export function getSession(
  sessionId: string,
  query: SessionQuery = {},
): Promise<SessionDetailResponse> {
  return unwrap<SessionDetailResponse>(
    client.api.sessions({ sessionId }).get({ query: withoutEmptyValues(query) }),
  );
}

export function listMemoryScopes(): Promise<MemoryScopesResponse> {
  return unwrap<MemoryScopesResponse>(client.api.memory.get());
}

export function getMemory(scope: MemoryScope): Promise<MemoryDetailResponse> {
  if (scope.type === "owner") {
    return unwrap<MemoryDetailResponse>(client.api.memory.owner.get());
  }
  return unwrap<MemoryDetailResponse>(client.api.memory.guild({ guildId: scope.guildId }).get());
}

export function deleteMemory(scope: MemoryScope, entryId: string): Promise<{ deleted: boolean }> {
  if (scope.type === "owner") {
    return unwrap<{ deleted: boolean }>(client.api.memory.owner({ entryId }).delete());
  }
  return unwrap<{ deleted: boolean }>(
    client.api.memory.guild({ guildId: scope.guildId })({ entryId }).delete(),
  );
}

export function addMemoryRule(
  scope: MemoryScope,
  input: { title: string; content: string },
): Promise<{ created: boolean }> {
  if (scope.type === "owner") {
    return unwrap<{ created: boolean }>(client.api.memory.owner.rules.post(input));
  }
  return unwrap<{ created: boolean }>(
    client.api.memory.guild({ guildId: scope.guildId }).rules.post(input),
  );
}

export function memoryScopeKey(scope: MemoryScope): string {
  return scope.type === "owner" ? "owner" : `guild:${scope.guildId}`;
}

export function parseMemoryScopeKey(key: string | null): MemoryScope | null {
  if (key === "owner") return { type: "owner" };
  if (key?.startsWith("guild:") && key.length > "guild:".length) {
    return { guildId: key.slice("guild:".length), type: "guild" };
  }
  return null;
}
