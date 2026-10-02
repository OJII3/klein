import { Type, type Static } from "typebox";

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });
const DiscordAccessSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny")]);

const DiscordThreadAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
  },
  { additionalProperties: false },
);

const DiscordChannelAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
    threads: Type.Optional(Type.Record(DiscordIdSchema, DiscordThreadAccessSchema)),
  },
  { additionalProperties: false },
);

const DiscordGuildAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
    channels: Type.Optional(Type.Record(DiscordIdSchema, DiscordChannelAccessSchema)),
  },
  { additionalProperties: false },
);

const LlmModelConfigurationProperties = {
  provider: Type.Union([Type.Literal("opencode-go"), Type.Literal("google-vertex")]),
  model: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
};

const LlmModelConfigurationSchema = Type.Object(LlmModelConfigurationProperties, {
  additionalProperties: false,
});

const LlmConfigurationSchema = Type.Object(
  {
    ...LlmModelConfigurationProperties,
    contextWindowRatio: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1 })),
    image: Type.Optional(LlmModelConfigurationSchema),
  },
  { additionalProperties: false },
);

const MemoryModelConfigurationSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("opencode-go"), Type.Literal("google-vertex")]),
    model: Type.String({ minLength: 1 }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

const MemoryConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    filePath: Type.Optional(Type.String({ minLength: 1 })),
    llm: Type.Optional(MemoryModelConfigurationSchema),
    idleSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    maxBatchAgeSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
    maxBatchMessages: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

const WebUiConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    host: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  },
  { additionalProperties: false },
);

const ProfileNameSchema = Type.String({
  minLength: 1,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String({ minLength: 1 })),
    version: Type.Literal(1),
    profile: Type.Optional(ProfileNameSchema),
    llm: LlmConfigurationSchema,
    runtime: Type.Object(
      {
        agentDir: Type.String({ minLength: 1 }),
        logDir: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    discord: Type.Object(
      {
        access: Type.Object(
          {
            default: DiscordAccessSchema,
            directMessages: DiscordAccessSchema,
            guilds: Type.Optional(Type.Record(DiscordIdSchema, DiscordGuildAccessSchema)),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        memory: Type.Object(MemoryConfigurationSchema.properties, { additionalProperties: false }),
        minecraft: Type.Object(
          {
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        webui: Type.Optional(WebUiConfigurationSchema),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: "https://github.com/OJII3/klein/blob/main/config/config.schema.json",
    additionalProperties: false,
    title: "Application configuration",
  },
);

export type AppConfig = Static<typeof ConfigSchema>;
