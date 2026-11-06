import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";

export function createDiscordSendTool(
  channelApi: Pick<DiscordChannelApi, "sendMessage" | "sendTyping">,
  channelId: Parameters<DiscordChannelApi["sendMessage"]>[0],
) {
  return defineTool({
    name: "discord_send",
    label: "Send Discord Message",
    exposure: "model-only",
    description: "Send a user-visible message to the current Discord conversation.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      await channelApi.sendTyping(channelId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await channelApi.sendMessage(channelId, params.content);

      return {
        content: [
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
