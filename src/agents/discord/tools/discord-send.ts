import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import type { DiscordService } from "@modules/discord/ports/discord-service";

export function createDiscordSendTool(
  discordService: Pick<DiscordService, "sendMessage" | "sendTyping">,
  channelId: Parameters<DiscordService["sendMessage"]>[0],
) {
  return defineTool({
    name: "discord_send",
    callers: ["model"],
    description: "Send a user-visible message to the current Discord conversation.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
    }),
    async execute(params) {
      await discordService.sendTyping(channelId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await discordService.sendMessage(channelId, params.content);

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
