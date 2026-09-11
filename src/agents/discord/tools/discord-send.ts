import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DiscordService } from "../../../modules/discord/ports/discord-service.js";

export function createDiscordSendTool(
  discordService: Pick<DiscordService, "sendMessage">,
  channelId: Parameters<DiscordService["sendMessage"]>[0],
) {
  return defineTool({
    name: "discord_send",
    label: "Send Discord message",
    description: "Send a user-visible message to the current Discord conversation.",
    promptSnippet: "Send a user-visible message to Discord.",
    promptGuidelines: [
      "Normal assistant text is not visible to the user; use discord_send for visible messages.",
      "Use next_action=continue when more work is needed; use next_action=finish for the final message.",
      "Do not call this tool when intentionally staying silent.",
    ],
    parameters: Type.Object({
      content: Type.String({ minLength: 1 }),
      next_action: Type.Union([Type.Literal("continue"), Type.Literal("finish")]),
    }),
    async execute(_toolCallId, params) {
      await discordService.sendMessage(channelId, params.content);

      return {
        content: [
          {
            type: "text",
            text:
              `The message was sent to Discord.\n` +
              `Sent content:\n${params.content}\n` +
              `Next action: ${params.next_action}.`,
          },
        ],
        details: {},
        terminate: params.next_action === "finish",
      };
    },
  });
}
