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

export const SessionQuerySchema = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
});

export const SkillParamsSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
});

export const SkillFileQuerySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 4096 }),
});

export const MemoryGuildParamsSchema = t.Object({
  guildId: t.String({
    minLength: 1,
    maxLength: 100,
    pattern: "^[A-Za-z0-9_-]+$",
  }),
});

export const MemoryUserParamsSchema = t.Object({
  userId: t.String({
    minLength: 1,
    maxLength: 32,
    pattern: "^[0-9]+$",
  }),
});

const MemoryScopeSchema = t.Union([
  t.Object({ type: t.Literal("guild") }),
  t.Object({
    type: t.Literal("channel"),
    channelId: t.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" }),
  }),
  t.Object({
    type: t.Literal("thread"),
    channelId: t.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" }),
    threadId: t.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" }),
  }),
]);

export const MemoryGuildFileBodySchema = t.Object({
  scope: MemoryScopeSchema,
  content: t.String({ maxLength: 200_000 }),
});

export const MemoryGuildDeleteBodySchema = t.Object({
  scope: MemoryScopeSchema,
});
