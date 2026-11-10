import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordUserResolver } from "@modules/discord/domain/discord-user";
import {
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
  | { readonly resolved: false; readonly found: false; readonly discordId: string }
  | {
      readonly resolved: true;
      readonly found: false;
      readonly discordId: string;
      readonly userId: string;
    }
  | {
      readonly resolved: true;
      readonly found: true;
      readonly discordId: string;
      readonly userId: string;
      readonly updatedAt: string;
    };

export function createUserMemoryTools(store: UserMemoryStore, users: DiscordUserResolver) {
  return [
    defineTool<typeof userMemoryGetParameters, UserMemoryGetDetails>({
      name: "user_memory_get",
      label: "Get User Memory",
      description: "Read a Discord user's memory by @username (not the numeric user ID).",
      parameters: userMemoryGetParameters,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const user = users.resolve(params.discord_id);
        if (!user) {
          return {
            content: [
              {
                type: "text",
                text: `Discordユーザーが見つかりません。discord_id: ${params.discord_id}。まだメッセージを見ていないユーザーは指定できません。`,
              },
            ],
            details: { resolved: false, found: false, discordId: params.discord_id },
          };
        }

        const memory = await store.read(user.id);
        if (!memory) {
          return {
            content: [
              {
                type: "text",
                text: `ユーザーメモリはまだありません。discord_id: ${user.username}`,
              },
            ],
            details: {
              resolved: true,
              found: false,
              discordId: user.username,
              userId: user.id,
            },
          };
        }

        return {
          content: [{ type: "text", text: renderUserMemory(memory) }],
          details: {
            resolved: true,
            found: true,
            discordId: user.username,
            userId: user.id,
            updatedAt: memory.updatedAt,
          },
        };
      },
    }),
    defineTool<typeof userMemoryUpdateParameters>({
      name: "user_memory_update",
      label: "Update User Memory",
      description:
        "Create or update a Discord user's memory by @username (not the numeric user ID). " +
        "Only passed fields change; sections replace wholesale. display_name is required on " +
        "first create. impression: -100..100 (0 neutral) or impression_delta. Facts: confirmed " +
        "only, `不明` if unknown, dates as `- key: YYYY-MM-DD`. null clears optional names.",
      parameters: userMemoryUpdateParameters,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        if (!hasAnyUpdate(params)) {
          throw new Error("更新する項目を1つ以上指定してください。");
        }
        if (params.impression !== undefined && params.impression_delta !== undefined) {
          throw new Error("impression と impression_delta は同時に指定できません。");
        }

        const user = users.resolve(params.discord_id);
        if (!user) {
          throw new Error(
            `Discordユーザーが見つかりません: ${params.discord_id}。まだメッセージを見ていないユーザーは指定できません。`,
          );
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
        const memory = await store.update(user.id, user.username, patch);
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
