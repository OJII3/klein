import { type Static, Type } from "typebox";

export const AsrClientMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("asr.start"),
      requestId: Type.String({ minLength: 1 }),
      language: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("asr.commit"), requestId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export type AsrClientMessage = Static<typeof AsrClientMessageSchema>;

export const AsrServerMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("asr.completed"),
      requestId: Type.String({ minLength: 1 }),
      text: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("asr.failed"),
      requestId: Type.String({ minLength: 1 }),
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type AsrServerMessage = Static<typeof AsrServerMessageSchema>;
