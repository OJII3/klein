import { Elysia } from "elysia";
import type { Logger } from "pino";

import { MemoryEntryNotFoundError } from "@modules/memory/domain/memory";
import {
  LogsQuerySchema,
  MemoryEntryParamsSchema,
  MemoryParamsSchema,
  MemoryRuleBodySchema,
  SessionParamsSchema,
  SessionQuerySchema,
} from "../domain/api-schema";
import type { ViewerLogQuery } from "../ports/viewer-readers";
import type { WebUiDependencies } from "../ports/webui";

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export function createWebUiApp(dependencies: WebUiDependencies) {
  return new Elysia({ name: "klein-webui" })
    .get("/api/health", () => ({ ok: true }))
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
      if (!dependencies.memory) return { enabled: false, items: [] };

      try {
        return { enabled: true, items: await dependencies.memory.listGuilds() };
      } catch (error) {
        return handleRouteError(set, dependencies.logger, error, "Failed to list guild memories");
      }
    })
    .get(
      "/api/memory/:guildId",
      async ({ params, set }) => {
        if (!dependencies.memory) {
          set.status = 404;
          return { error: "Memory is disabled" };
        }

        try {
          const document = await dependencies.memory.read(params.guildId);
          return { entries: document.entries, guildId: params.guildId };
        } catch (error) {
          return handleRouteError(set, dependencies.logger, error, "Failed to read guild memory");
        }
      },
      { params: MemoryParamsSchema },
    )
    .delete(
      "/api/memory/:guildId/:entryId",
      async ({ params, set }) => {
        if (!dependencies.memory) {
          set.status = 404;
          return { error: "Memory is disabled" };
        }
        if (!dependencies.memoryEditor) {
          set.status = 405;
          return { error: "Memory editing is disabled" };
        }

        try {
          await dependencies.memoryEditor.deleteEntry(params.guildId, params.entryId);
          return { deleted: true };
        } catch (error) {
          if (error instanceof MemoryEntryNotFoundError) {
            set.status = 404;
            return { error: "Memory entry not found" };
          }
          return handleRouteError(set, dependencies.logger, error, "Failed to delete guild memory");
        }
      },
      { params: MemoryEntryParamsSchema },
    )
    .post(
      "/api/memory/:guildId/rules",
      async ({ params, body, set }) => {
        if (!dependencies.memory || !dependencies.memoryEditor) {
          set.status = 404;
          return { error: "Memory editing is disabled" };
        }
        try {
          await dependencies.memoryEditor.addRule(
            params.guildId,
            body.title.trim(),
            body.content.trim(),
          );
          return { created: true };
        } catch (error) {
          return handleRouteError(
            set,
            dependencies.logger,
            error,
            "Failed to add guild memory rule",
          );
        }
      },
      { params: MemoryParamsSchema, body: MemoryRuleBodySchema },
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
  logger: Logger | undefined,
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
