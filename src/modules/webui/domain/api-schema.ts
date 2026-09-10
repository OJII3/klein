import { t } from "elysia";

export const LogsQuerySchema = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  level: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  q: t.Optional(t.String({ maxLength: 200 })),
  channelId: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  event: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
});

export const SessionParamsSchema = t.Object({
  sessionId: t.String({ minLength: 1, maxLength: 100 }),
});
