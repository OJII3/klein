import { Elysia } from "elysia";

import {
  LogsQuerySchema,
  MemoryGuildDeleteBodySchema,
  MemoryGuildFileBodySchema,
  MemoryGuildParamsSchema,
  MemoryUserParamsSchema,
  SessionParamsSchema,
  SessionQuerySchema,
} from "./api-schema";
import type { ViewerLogQuery } from "./viewer-readers";
import type { WebUiDependencies, WebUiLogger } from "./webui";

export type WebUiApp = ReturnType<typeof createWebUiApp>;

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export function createWebUiApp(dependencies: WebUiDependencies) {
  return new Elysia({ name: "klein-webui" })
    .get("/api/health", () => ({ ok: true }))
    .get("/api/meta", () => ({ displayName: dependencies.displayName }))
    .get("/api/channels", async ({ set }) => {
      try {
        if (!dependencies.channelNames) return { items: [] };
        const names = await dependencies.channelNames.read();
        return {
          items: [...names].map(([channelId, name]) => ({ channelId, name })),
        };
      } catch (error) {
        return handleRouteError(set, dependencies.logger, error, "Failed to list Discord channels");
      }
    })
    .get("/api/guilds", async ({ set }) => {
      try {
        if (!dependencies.guildNames) return { items: [] };
        const names = await dependencies.guildNames.read();
        return {
          items: [...names].map(([guildId, name]) => ({ guildId, name })),
        };
      } catch (error) {
        return handleRouteError(set, dependencies.logger, error, "Failed to list Discord guilds");
      }
    })
    .get("/api/tools", async ({ set }) => {
      try {
        return await dependencies.toolUsage.read();
      } catch (error) {
        return handleRouteError(set, dependencies.logger, error, "Failed to aggregate tool usage");
      }
    })
    .get("/api/proactivity", async ({ set }) => {
      try {
        if (!dependencies.proactivity) {
          return {
            enabled: false,
            signals: [],
            signalsTruncated: false,
            followUps: [],
            preferences: [],
          };
        }
        return { enabled: true, ...(await dependencies.proactivity.read()) };
      } catch (error) {
        return handleRouteError(
          set,
          dependencies.logger,
          error,
          "Failed to read proactivity state",
        );
      }
    })
    .get(
      "/api/logs",
      async ({ query, set }) => {
        try {
          const logQuery: ViewerLogQuery = {
            channelId: query.channelId,
            cursor: query.cursor,
            event: query.event,
            level: query.level,
            limit: parseLimit(query.limit),
            q: query.q,
          };
          validateLogQuery(logQuery);
          return await dependencies.pinoLogs.list(logQuery);
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to list pino logs");
        }
      },
      { query: LogsQuerySchema },
    )
    .get(
      "/api/sessions",
      async ({ query, set }) => {
        try {
          return await dependencies.piSessions.list(query);
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to list Pi sessions");
        }
      },
      { query: SessionQuerySchema },
    )
    .get(
      "/api/sessions/:sessionId",
      async ({ params, query, set }) => {
        try {
          const detail = await dependencies.piSessions.get(params.sessionId, query);
          if (!detail) {
            set.status = 404;
            return { error: "Session not found" };
          }
          return detail;
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to read Pi session");
        }
      },
      { params: SessionParamsSchema, query: SessionQuerySchema },
    )
    .get("/api/memory", async ({ set }) => {
      try {
        const items = dependencies.memory ? await dependencies.memory.listScopes() : [];
        const users = dependencies.userMemory ? await dependencies.userMemory.list() : [];
        return {
          enabled: dependencies.memory !== undefined,
          items,
          userMemoryEnabled: dependencies.userMemory !== undefined,
          users,
        };
      } catch (error) {
        return handleRouteError(set, dependencies.logger, error, "Failed to list memories");
      }
    })
    .get(
      "/api/memory/user/:userId",
      async ({ params, set }) => {
        if (!dependencies.userMemory) {
          set.status = 404;
          return { error: "User memory is disabled" };
        }

        try {
          const memory = await dependencies.userMemory.read(params.userId);
          if (!memory) {
            set.status = 404;
            return { error: "User memory not found" };
          }
          return { memory };
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to read user memory");
        }
      },
      { params: MemoryUserParamsSchema },
    )
    .delete(
      "/api/memory/user/:userId",
      async ({ params, set }) => {
        if (!dependencies.userMemory) {
          set.status = 404;
          return { error: "User memory is disabled" };
        }
        if (!dependencies.userMemoryEditor) {
          set.status = 405;
          return { error: "User memory editing is disabled" };
        }

        try {
          const deleted = await dependencies.userMemoryEditor.delete(params.userId);
          if (!deleted) {
            set.status = 404;
            return { error: "User memory not found" };
          }
          return { deleted: true };
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to delete user memory");
        }
      },
      { params: MemoryUserParamsSchema },
    )
    .get(
      "/api/memory/guild/:guildId",
      async ({ params, set }) => {
        if (!dependencies.memory) {
          set.status = 404;
          return { error: "Memory is disabled" };
        }

        try {
          return await dependencies.memory.readGuild(params.guildId);
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to read shared memory");
        }
      },
      { params: MemoryGuildParamsSchema },
    )
    .put(
      "/api/memory/guild/:guildId/file",
      async ({ body, params, set }) => {
        if (!dependencies.memoryEditor) {
          set.status = 405;
          return { error: "Memory editing is disabled" };
        }

        try {
          await dependencies.memoryEditor.writeFile(params.guildId, body.scope, body.content);
          return { saved: true };
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to save shared memory");
        }
      },
      { body: MemoryGuildFileBodySchema, params: MemoryGuildParamsSchema },
    )
    .delete(
      "/api/memory/guild/:guildId/file",
      async ({ body, params, set }) => {
        if (!dependencies.memoryEditor) {
          set.status = 405;
          return { error: "Memory editing is disabled" };
        }

        try {
          await dependencies.memoryEditor.deleteFile(params.guildId, body.scope);
          return { deleted: true };
        } catch (error) {
          return handleRouteError(
            set,
            dependencies.logger,
            error,
            "Failed to delete shared memory",
          );
        }
      },
      { body: MemoryGuildDeleteBodySchema, params: MemoryGuildParamsSchema },
    );
}

function validateLogQuery(query: ViewerLogQuery): void {
  if (query.level && !LOG_LEVELS.has(query.level) && !/^\d+$/.test(query.level)) {
    throw new WebUiRequestError(`Unknown log level: ${query.level}`);
  }
}

function parseLimit(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new WebUiRequestError("Log limit must be an integer between 1 and 200");
  }
  return limit;
}

function handleRouteError(
  set: { status?: number | string },
  logger: WebUiLogger | undefined,
  error: unknown,
  message: string,
): { error: string } {
  if (error instanceof WebUiRequestError || isClientError(error)) {
    set.status = 400;
    return { error: error instanceof Error ? error.message : String(error) };
  }

  logger?.error({ err: error, event: "webui_request_failed" }, message);
  set.status = 500;
  return { error: "Internal server error" };
}

function isClientError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("Invalid log cursor") ||
      error.message.startsWith("Unknown log cursor") ||
      error.message.startsWith("Log limit") ||
      error.message.startsWith("Invalid session cursor") ||
      error.message.startsWith("Unknown session cursor") ||
      error.message.startsWith("Session event limit") ||
      error.message.startsWith("Invalid session list cursor") ||
      error.message.startsWith("Unknown session list cursor"))
  );
}

class WebUiRequestError extends Error {}
