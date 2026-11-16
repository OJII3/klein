import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { defineSurfaceTool } from "./surface-tool";

export function createDiscordSendTool(
  channelApi: Pick<DiscordChannelApi, "sendMessage" | "sendTyping">,
  channelId: Parameters<DiscordChannelApi["sendMessage"]>[0],
) {
  return defineSurfaceTool({
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
      const sent = await channelApi.sendMessage(channelId, params.content);
      const messageIds = Array.isArray(sent) ? sent : [];

      return {
        content: [
          {
            type: "text",
            text: `The message was sent to Discord.\nSent content:\n${params.content}`,
          },
        ],
        details: messageIds.length > 0 ? { messageIds } : {},
      };
    },
  });
}
