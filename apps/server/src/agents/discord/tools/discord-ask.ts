import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { defineSurfaceTool } from "./surface-tool";

export function createDiscordAskTool(
  channelApi: Pick<DiscordChannelApi, "sendChoices">,
  channelId: string,
  requesterUserId: () => string | undefined,
  onMessageSent?: () => void,
) {
  return defineSurfaceTool(
    {
      name: "discord_ask",
      label: "Ask with Discord Buttons",
      exposure: "model-only",
      description:
        "Post a question with 2 to 5 selectable buttons to the current Discord conversation. " +
        "The answer arrives later as a new user message, so do not wait for it in this turn.",
      parameters: Type.Object({
        question: Type.String({ minLength: 1, maxLength: 2_000 }),
        options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
          minItems: 2,
          maxItems: 5,
        }),
      }),
      async execute(_toolCallId, params) {
        const userId = requesterUserId();
        if (!userId) {
          throw new Error("discord_ask is only available during a turn started by a Discord user");
        }

        const messageId = await channelApi.sendChoices(channelId, {
          question: params.question,
          options: params.options,
          requesterUserId: userId,
        });
        onMessageSent?.();

        return {
          content: [
            {
              type: "text",
              text:
                "The question was posted to Discord with selectable buttons.\n" +
                "The answer will arrive later as a new user message. Do not wait for it or repeat the question.\n" +
                `Question: ${params.question}\n` +
                `Options: ${params.options.join(", ")}`,
            },
          ],
          details: { messageId },
        };
      },
    },
    { outcome: "Asked a question in Discord." },
  );
}
