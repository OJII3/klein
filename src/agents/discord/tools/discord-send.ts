import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";

export function createDiscordSendTool(
  channelApi: Pick<DiscordChannelApi, "sendMessage" | "sendTyping">,
  channelId: Parameters<DiscordChannelApi["sendMessage"]>[0],
) {
  return defineTool({
    name: "discord_send",
    callers: ["model"],
    description: "Send a user-visible message to the current Discord conversation.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
    }),
    async execute(params) {
      await channelApi.sendTyping(channelId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await channelApi.sendMessage(channelId, params.content);

      return {
        output: [
          {
            type: "text",
            text: `The message was sent to Discord.\nSent content:\n${params.content}`,
          },
        ],
        details: {},
      };
    },
  });
}
