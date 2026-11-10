import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  USER_MEMORY_FACTS_FORMAT_GUIDE,
  USER_MEMORY_IMPRESSION_MAX,
  USER_MEMORY_IMPRESSION_MIN,
  type UserMemoryPatch,
  type UserMemoryStore,
} from "@modules/user-memory/domain/user-memory";
import { renderUserMemory } from "@modules/user-memory/infrastructure/markdown-user-memory-store";

const discordIdSchema = Type.String({ minLength: 1, maxLength: 100 });
const optionalTextSchema = Type.Union([Type.String({ maxLength: 100 }), Type.Null()]);
const sectionSchema = Type.String({ maxLength: 20_000 });

const userMemoryGetParameters = Type.Object({
  discord_id: discordIdSchema,
});

const userMemoryUpdateParameters = Type.Object({
  discord_id: discordIdSchema,
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  nickname: Type.Optional(optionalTextSchema),
  first_name: Type.Optional(optionalTextSchema),
  last_name: Type.Optional(optionalTextSchema),
  summary: Type.Optional(Type.String({ maxLength: 500 })),
  impression: Type.Optional(
    Type.Integer({
      minimum: USER_MEMORY_IMPRESSION_MIN,
      maximum: USER_MEMORY_IMPRESSION_MAX,
    }),
  ),
  impression_delta: Type.Optional(
    Type.Integer({
      minimum: USER_MEMORY_IMPRESSION_MIN,
      maximum: USER_MEMORY_IMPRESSION_MAX,
    }),
  ),
  facts: Type.Optional(sectionSchema),
  history: Type.Optional(sectionSchema),
  in_common: Type.Optional(sectionSchema),
  strengthening: Type.Optional(sectionSchema),
});

type UserMemoryGetDetails =
  | { readonly found: false; readonly discordId: string }
  | { readonly found: true; readonly discordId: string; readonly updatedAt: string };

export function createUserMemoryTools(store: UserMemoryStore) {
  return [
    defineTool<typeof userMemoryGetParameters, UserMemoryGetDetails>({
      name: "user_memory_get",
      label: "Get User Memory",
      description:
        "Read the per-user memory for a Discord user. Pass the user-set Discord username shown " +
        "as @username in messages, without the @, as discord_id. This is not the numeric " +
        "snowflake ID. The memory is a Markdown document with front matter (display_name, " +
        "summary, impression, updated_at) and the sections Facts, History, In common, and " +
        "Strengthening. This tool looks up by username only; it does not search by display name.",
      parameters: userMemoryGetParameters,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const memory = await store.read(params.discord_id);
        if (!memory) {
          return {
            content: [
              {
                type: "text",
                text: `ユーザーメモリはまだありません。discord_id: ${params.discord_id}`,
              },
            ],
            details: { found: false, discordId: params.discord_id },
          };
        }

        return {
          content: [{ type: "text", text: renderUserMemory(memory) }],
          details: {
            found: true,
            discordId: memory.discordId,
            updatedAt: memory.updatedAt,
          },
        };
      },
    }),
    defineTool<typeof userMemoryUpdateParameters>({
      name: "user_memory_update",
      label: "Update User Memory",
      description:
        "Create or update the per-user memory for a Discord user. Pass the user-set Discord " +
        "username shown as @username in messages, without the @, as discord_id. This is not " +
        "the numeric snowflake ID. Only the fields you pass are changed. The section fields " +
        "replace the whole section, so call user_memory_get first. " +
        `${USER_MEMORY_FACTS_FORMAT_GUIDE} ` +
        "impression is an integer from -100 (strong dislike) to 100 (strong affinity), with 0 " +
        "neutral; impression_delta adds to the current value and is clamped to that range. " +
        "Pass null for nickname, first_name, or last_name to clear it. display_name is required " +
        "when the user has no memory file yet.",
      parameters: userMemoryUpdateParameters,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        if (!hasAnyUpdate(params)) {
          throw new Error("更新する項目を1つ以上指定してください。");
        }
        if (params.impression !== undefined && params.impression_delta !== undefined) {
          throw new Error("impression と impression_delta は同時に指定できません。");
        }

        const patch: UserMemoryPatch = {
          ...(params.display_name !== undefined ? { displayName: params.display_name } : {}),
          ...(params.nickname !== undefined ? { nickname: params.nickname } : {}),
          ...(params.first_name !== undefined ? { firstName: params.first_name } : {}),
          ...(params.last_name !== undefined ? { lastName: params.last_name } : {}),
          ...(params.summary !== undefined ? { summary: params.summary } : {}),
          ...(params.impression !== undefined ? { impression: params.impression } : {}),
          ...(params.impression_delta !== undefined
            ? { impressionDelta: params.impression_delta }
            : {}),
          ...(params.facts !== undefined ? { facts: params.facts } : {}),
          ...(params.history !== undefined ? { history: params.history } : {}),
          ...(params.in_common !== undefined ? { inCommon: params.in_common } : {}),
          ...(params.strengthening !== undefined ? { strengthening: params.strengthening } : {}),
        };
        const memory = await store.update(params.discord_id, patch);
        return {
          content: [
            {
              type: "text",
              text: `ユーザーメモリを更新しました。discord_id: ${memory.discordId} / updated_at: ${memory.updatedAt}`,
            },
          ],
          details: {
            discordId: memory.discordId,
            updatedAt: memory.updatedAt,
            impression: memory.impression,
          },
        };
      },
    }),
  ];
}

function hasAnyUpdate(params: Record<string, unknown>): boolean {
  return Object.keys(params).some((key) => key !== "discord_id" && params[key] !== undefined);
}
