import { type Static, Type } from "typebox";

const AudioFormatSchema = Type.Object(
  {
    encoding: Type.Literal("pcm_s16le"),
    sampleRateHz: Type.Literal(16_000),
    channels: Type.Literal(1),
  },
  { additionalProperties: false },
);

export const AsrClientMessageSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("session.start"),
      language: Type.String({ minLength: 1 }),
      audio: AudioFormatSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("utterance.start"), utteranceId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("utterance.end"), utteranceId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export type AsrClientMessage = Static<typeof AsrClientMessageSchema>;

const UtteranceTranscriptSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("transcript.partial"), Type.Literal("transcript.final")]),
    utteranceId: Type.String({ minLength: 1 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const AsrServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("session.ready") }, { additionalProperties: false }),
  UtteranceTranscriptSchema,
  Type.Object(
    {
      type: Type.Literal("error"),
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type AsrServerMessage = Static<typeof AsrServerMessageSchema>;
