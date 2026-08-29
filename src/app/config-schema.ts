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
