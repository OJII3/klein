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

const AgentPromptConfigurationSchema = Type.Object(
  {
    systemPromptFile: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const KleinConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String({ minLength: 1 })),
    version: Type.Literal(1),
    llm: Type.Object(
      {
        provider: Type.Literal("opencode-go"),
        model: Type.String({ minLength: 1 }),
        thinkingLevel: Type.Optional(ThinkingLevelSchema),
      },
      { additionalProperties: false },
    ),
    runtime: Type.Object(
      {
        agentDir: Type.String({ minLength: 1 }),
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
    agents: Type.Optional(
      Type.Object(
        {
          discord: Type.Optional(AgentPromptConfigurationSchema),
        },
        { additionalProperties: false },
      ),
    ),
    features: Type.Object(
      {
        memory: Type.Object(
          {
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        minecraft: Type.Object(
          {
            enabled: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: "https://github.com/OJII3/klein/blob/main/config/klein.schema.json",
    additionalProperties: false,
    title: "Klein configuration",
  },
);

export type KleinConfig = Static<typeof KleinConfigSchema>;
