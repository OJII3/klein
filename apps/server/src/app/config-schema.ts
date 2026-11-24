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

export const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });
const DiscordAccessSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("owner"),
]);

const PermissionAccessSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("user"),
  Type.Literal("owner"),
]);

const ToolPermissionsSchema = Type.Object(
  {
    default: Type.Optional(PermissionAccessSchema),
    overrides: Type.Optional(Type.Record(Type.String({ minLength: 1 }), PermissionAccessSchema)),
  },
  { additionalProperties: false },
);

const McpPermissionsSchema = Type.Object(
  {
    default: Type.Optional(PermissionAccessSchema),
    servers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), PermissionAccessSchema)),
  },
  { additionalProperties: false },
);

const LlmProviderSchema = Type.Union([
  Type.Literal("opencode-go"),
  Type.Literal("google"),
  Type.Literal("mistral"),
]);

const LlmModelConfigurationProperties = {
  provider: LlmProviderSchema,
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
    compaction: Type.Optional(
      Type.Object(
        { backgroundTokens: Type.Optional(Type.Integer({ minimum: 0 })) },
        { additionalProperties: false },
      ),
    ),
    image: Type.Optional(LlmModelConfigurationSchema),
  },
  { additionalProperties: false },
);

const MemoryModelConfigurationSchema = Type.Object(
  {
    provider: LlmProviderSchema,
    model: Type.String({ minLength: 1 }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

const SharedMemoryConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    directory: Type.Optional(Type.String({ minLength: 1 })),
    llm: Type.Optional(MemoryModelConfigurationSchema),
    idleSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    maxBatchAgeSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
    maxBatchMessages: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

const UserMemoryConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    directory: Type.Optional(Type.String({ minLength: 1 })),
    llm: Type.Optional(MemoryModelConfigurationSchema),
  },
  { additionalProperties: false },
);

const ProactiveDeliveryModeSchema = Type.Union([
  Type.Literal("interrupt"),
  Type.Literal("attach"),
  Type.Literal("digest"),
  Type.Literal("silent"),
]);

const InitiativeConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    goalsDirectory: Type.Optional(Type.String({ minLength: 1 })),
    plannerStateDirectory: Type.Optional(Type.String({ minLength: 1 })),
    llm: Type.Optional(MemoryModelConfigurationSchema),
    planAfterIdleMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_440 })),
    planWithinHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
    maxMessages: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    maxPlansPerDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    maxGoalsPerDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    maxActiveGoals: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    maxGoalsPerPlan: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    approval: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("propose"), Type.Literal("off")]),
    ),
  },
  { additionalProperties: false },
);

const ProactivityConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    preferencesDirectory: Type.Optional(Type.String({ minLength: 1 })),
    followUpDirectory: Type.Optional(Type.String({ minLength: 1 })),
    signalDirectory: Type.Optional(Type.String({ minLength: 1 })),
    initiative: Type.Optional(InitiativeConfigurationSchema),
    defaultMode: Type.Optional(ProactiveDeliveryModeSchema),
    quietHours: Type.Optional(
      Type.Object(
        {
          start: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
          end: Type.String({ pattern: "^\\d{2}:\\d{2}$" }),
        },
        { additionalProperties: false },
      ),
    ),
    digestAt: Type.Optional(Type.String({ pattern: "^\\d{2}:\\d{2}$" })),
    maxPerDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    publicChannels: Type.Optional(Type.Boolean()),
    promiseGuard: Type.Optional(
      Type.Union([Type.Literal("off"), Type.Literal("log"), Type.Literal("block")]),
    ),
  },
  { additionalProperties: false },
);

const WebUiConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    host: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    cloudflared: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const TtsConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    serverUrl: Type.String({ minLength: 1, format: "uri" }),
  },
  { additionalProperties: false },
);

const VoiceChatConfigurationSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    asrServerUrl: Type.String({ minLength: 1, format: "uri" }),
    language: Type.Optional(Type.String({ minLength: 1 })),
    llm: Type.Optional(LlmModelConfigurationSchema),
    classifier: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ minLength: 1 }),
          model: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
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
    owner: Type.Optional(
      Type.Object(
        {
          discord: Type.Object(
            {
              userId: DiscordIdSchema,
              communicationChannelId: Type.Optional(DiscordIdSchema),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    permissions: Type.Optional(
      Type.Object(
        {
          tools: Type.Optional(ToolPermissionsSchema),
          mcp: Type.Optional(McpPermissionsSchema),
        },
        { additionalProperties: false },
      ),
    ),
    llm: LlmConfigurationSchema,
    runtime: Type.Object(
      {
        agentDir: Type.String({ minLength: 1 }),
        logDir: Type.Optional(Type.String({ minLength: 1 })),
        stateDir: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    discord: Type.Object(
      {
        access: Type.Object(
          {
            default: DiscordAccessSchema,
            directMessages: DiscordAccessSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        sharedMemory: Type.Object(SharedMemoryConfigurationSchema.properties, {
          additionalProperties: false,
        }),
        userMemory: Type.Optional(UserMemoryConfigurationSchema),
        proactivity: Type.Optional(ProactivityConfigurationSchema),
        minecraft: Type.Object(
          {
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        webui: Type.Optional(WebUiConfigurationSchema),
        tts: Type.Optional(TtsConfigurationSchema),
        voiceChat: Type.Optional(VoiceChatConfigurationSchema),
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
