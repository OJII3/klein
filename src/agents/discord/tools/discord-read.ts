import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDiscordMessage } from "../../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../../modules/discord/ports/discord-service.js";

export function createDiscordReadTool(
  discordService: Pick<DiscordService, "readMessage">,
  currentChannelId: string,
) {
  return defineTool({
    name: "discord_read",
    label: "Read Discord message",
    description: "Read a Discord message by ID. Use the current channel when channelId is omitted.",
    promptSnippet: "Read a Discord message by ID.",
    promptGuidelines: [
      "When given a Discord message link, extract its channel ID and message ID.",
      "Use channelId from search results when reading a message from another channel.",
    ],
    parameters: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      channelId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params) {
      const message = await discordService.readMessage({
        channelId: params.channelId ?? currentChannelId,
        messageId: params.messageId,
      });

      return {
        content: [
          {
            type: "text",
            text: formatDiscordMessage(message),
          },
        ],
        details: {
          channelId: message.channelId,
          messageId: message.id,
        },
      };
    },
  });
}
