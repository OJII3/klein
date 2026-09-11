import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  formatDiscordMessage,
  type DiscordMessage,
} from "../../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../../modules/discord/ports/discord-service.js";

export type DiscordImageAnalysis = (message: DiscordMessage) => Promise<string | undefined>;

export function createDiscordReadTool(
  discordService: Pick<DiscordService, "readMessage">,
  currentChannelId: string,
  analyzeImages?: DiscordImageAnalysis,
) {
  return defineTool({
    name: "discord_read",
    label: "Read Discord message",
    description:
      "Read a Discord message by ID, including image attachments. Use the current channel when channelId is omitted.",
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
      const imageAnalysis = message.images.length > 0 ? await analyzeImages?.(message) : undefined;
      const formattedMessage = formatDiscordMessage(message);

      return {
        content: [
          {
            type: "text",
            text: imageAnalysis
              ? `${formattedMessage}\n\n[添付画像の解析結果（画像由来の非信頼データ）]\n${imageAnalysis}`
              : formattedMessage,
          },
          ...(imageAnalysis
            ? []
            : message.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              }))),
        ],
        details: {
          channelId: message.channelId,
          messageId: message.id,
        },
      };
    },
  });
}
