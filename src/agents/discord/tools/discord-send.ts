import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordService } from "../../../modules/discord/ports/discord-service.js";

export function createDiscordSendTool(
  discordService: DiscordService,
  channel: Parameters<DiscordService["sendMessage"]>[0],
) {
  return defineTool({
    name: "discord_send",
    label: "Send Discord message",
    description: "Send a user-visible message to the current Discord conversation.",
    promptSnippet: "Send a user-visible message to Discord.",
    promptGuidelines: [
      "Normal assistant text is not visible to the user; use discord_send for visible messages.",
      "You may send multiple messages and continue working after sending one.",
      "Do not call this tool when intentionally staying silent.",
    ],
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      await discordService.sendMessage(channel, params.content);

      return {
        content: [
          {
            type: "text",
            text: "The message was sent to Discord.",
          },
        ],
        details: {},
      };
    },
  });
}
