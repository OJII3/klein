import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordUserResolver } from "@modules/discord/domain/discord-user";
import type { UserMemoryStore } from "@modules/user-memory/domain/user-memory";
import { renderUserMemory } from "@modules/user-memory/infrastructure/markdown-user-memory-store";

const discordIdSchema = Type.String({ minLength: 1, maxLength: 100 });

const userMemoryGetParameters = Type.Object({
  discord_id: discordIdSchema,
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
      description: "Read a Discord user's memory by @username.",
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
  ];
}
