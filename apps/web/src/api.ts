import { treaty } from "@elysia/eden";

import type {
  FollowUpStatus,
  FollowUpView,
  FollowUpWatcherKind,
  InitiativeGoalDelivery,
  InitiativeGoalRisk,
  InitiativeGoalStatus,
  InitiativeGoalView,
  SharedMemoryFile,
  SharedMemoryGuild,
  SharedMemoryScope,
  McpServerUsageStat,
  MemoryScope,
  MemoryScopeSummary,
  PiViewerEvent,
  PinoViewerEvent,
  ProactiveDeliveryMode,
  ProactivePreferenceView,
  ProactiveSignalStatus,
  ProactiveSignalView,
  ProactiveTopicMode,
  ProactiveUrgency,
  ProactivityReport,
  ToolUsageReport,
  ToolUsageStat,
  UserMemory,
  UserMemorySectionKey,
  UserMemorySummary,
  ViewerLogQuery,
  ViewerPage,
  ViewerSessionDetail,
  ViewerSessionQuery,
  ViewerSessionSummary,
  WebUiApp,
} from "@klein/webui-api";

export type {
  FollowUpStatus,
  FollowUpView,
  FollowUpWatcherKind,
  InitiativeGoalDelivery,
  InitiativeGoalRisk,
  InitiativeGoalStatus,
  InitiativeGoalView,
  SharedMemoryFile,
  SharedMemoryGuild,
  SharedMemoryScope,
  McpServerUsageStat,
  MemoryScope,
  MemoryScopeSummary,
  ProactiveDeliveryMode,
  ProactivePreferenceView,
  ProactiveSignalStatus,
  ProactiveSignalView,
  ProactiveTopicMode,
  ProactiveUrgency,
  ProactivityReport,
  ToolUsageReport,
  ToolUsageStat,
  UserMemory,
  UserMemorySectionKey,
  UserMemorySummary,
};

export type PinoLog = PinoViewerEvent;
export type LogsResponse = ViewerPage<PinoViewerEvent>;
export type LogsQuery = ViewerLogQuery;
export type SessionSummary = ViewerSessionSummary;
export type SessionsResponse = ViewerPage<ViewerSessionSummary>;
export type PiSessionEvent = PiViewerEvent;
export type SessionDetailResponse = ViewerSessionDetail;
export type SessionQuery = ViewerSessionQuery;

export interface ChannelSummary {
  channelId: string;
  name: string;
}

export interface ChannelsResponse {
  items: ChannelSummary[];
}

export interface GuildSummary {
  guildId: string;
  name: string;
}

export interface GuildsResponse {
  items: GuildSummary[];
}

export interface MetaResponse {
  displayName: string;
}

export type UserMemoryScope = { type: "user"; userId: string };

export type MemorySelection = MemoryScope | UserMemoryScope;

export interface MemoryScopesResponse {
  enabled: boolean;
  items: readonly MemoryScopeSummary[];
  userMemoryEnabled: boolean;
  users: readonly UserMemorySummary[];
}

export interface UserMemoryResponse {
  memory: UserMemory;
}

export interface SharedMemoryResponse {
  guildId: string;
  files: readonly SharedMemoryFile[];
}

const apiOrigin = typeof window === "undefined" ? "http://127.0.0.1:4310" : window.location.origin;

const client = treaty<WebUiApp>(apiOrigin, { parseDate: false });

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

function isErrorBody(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

async function unwrap<T>(
  request: Promise<{ data: T | { error: string } | null; error: unknown }>,
): Promise<T> {
  const response = await request;
  if (response.error) throw new Error(errorMessage(response.error));
  if (response.data === null || response.data === undefined) {
    throw new Error("APIレスポンスが空です");
  }
  if (isErrorBody(response.data)) {
    throw new Error(response.data.error);
  }
  return response.data;
}

function cleanLogsQuery(query: LogsQuery): LogsQuery {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.level ? { level: query.level } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.channelId ? { channelId: query.channelId } : {}),
    ...(query.event ? { event: query.event } : {}),
  };
}

function cleanSessionQuery(query: SessionQuery): SessionQuery {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

export function listLogs(query: LogsQuery = {}): Promise<LogsResponse> {
  return unwrap<LogsResponse>(
    client.api.logs.get({ query: cleanLogsQuery({ limit: 100, ...query }) }),
  );
}

export function listSessions(query: SessionQuery = {}): Promise<SessionsResponse> {
  return unwrap<SessionsResponse>(
    client.api.sessions.get({ query: cleanSessionQuery({ limit: 100, ...query }) }),
  );
}

export function listChannels(): Promise<ChannelsResponse> {
  return unwrap<ChannelsResponse>(client.api.channels.get());
}

export function listGuilds(): Promise<GuildsResponse> {
  return unwrap<GuildsResponse>(client.api.guilds.get());
}

export function getMeta(): Promise<MetaResponse> {
  return unwrap<MetaResponse>(client.api.meta.get());
}

export function getSession(
  sessionId: string,
  query: SessionQuery = {},
): Promise<SessionDetailResponse> {
  return unwrap<SessionDetailResponse>(
    client.api.sessions({ sessionId }).get({ query: cleanSessionQuery(query) }),
  );
}

export function listMemoryScopes(): Promise<MemoryScopesResponse> {
  return unwrap<MemoryScopesResponse>(client.api.memory.get());
}

export function getToolUsage(): Promise<ToolUsageReport> {
  return unwrap<ToolUsageReport>(client.api.tools.get());
}

export function getProactivity(): Promise<ProactivityReport> {
  return unwrap<ProactivityReport>(client.api.proactivity.get());
}

export function getSharedMemory(guildId: string): Promise<SharedMemoryResponse> {
  return unwrap<SharedMemoryResponse>(client.api.memory.guild({ guildId }).get());
}

export function saveSharedMemoryFile(
  guildId: string,
  scope: SharedMemoryScope,
  content: string,
): Promise<{ saved: boolean }> {
  return unwrap<{ saved: boolean }>(
    client.api.memory.guild({ guildId }).file.put({ content, scope }),
  );
}

export function deleteSharedMemoryFile(
  guildId: string,
  scope: SharedMemoryScope,
): Promise<{ deleted: boolean }> {
  return unwrap<{ deleted: boolean }>(client.api.memory.guild({ guildId }).file.delete({ scope }));
}

export function getUserMemory(userId: string): Promise<UserMemoryResponse> {
  return unwrap<UserMemoryResponse>(client.api.memory.user({ userId }).get());
}

export function deleteUserMemory(userId: string): Promise<{ deleted: boolean }> {
  return unwrap<{ deleted: boolean }>(client.api.memory.user({ userId }).delete());
}

export function memoryScopeKey(scope: MemorySelection): string {
  if (scope.type === "user") return `user:${scope.userId}`;
  return `guild:${scope.guildId}`;
}

export function sharedMemoryScopeKey(scope: SharedMemoryScope): string {
  if (scope.type === "guild") return "guild";
  if (scope.type === "channel") return `channel:${scope.channelId}`;
  return `thread:${scope.channelId}:${scope.threadId}`;
}

export function parseMemoryScopeKey(key: string | null): MemorySelection | null {
  if (key?.startsWith("guild:") && key.length > "guild:".length) {
    return { guildId: key.slice("guild:".length), type: "guild" };
  }
  if (key?.startsWith("user:") && key.length > "user:".length) {
    return { type: "user", userId: key.slice("user:".length) };
  }
  return null;
}
