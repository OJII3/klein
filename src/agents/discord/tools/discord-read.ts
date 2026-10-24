import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";

export type DiscordImageAnalysis = (message: DiscordMessage) => Promise<string | undefined>;

export function createDiscordReadTool(
  discordService: Pick<DiscordService, "readMessage">,
  currentChannelId: string,
  analyzeImages?: DiscordImageAnalysis,
  requester?: Parameters<DiscordService["readMessage"]>[1],
) {
  return defineTool({
    name: "discord_read",
    description:
      "Read a Discord message by ID, including image attachments. Use the current channel when channelId is omitted.",
    parameters: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      channelId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    replay: "safe",
    async execute(params) {
      const message = await discordService.readMessage(
        {
          channelId: params.channelId ?? currentChannelId,
          messageId: params.messageId,
        },
        requester,
      );
      const imageAnalysis = message.images.length > 0 ? await analyzeImages?.(message) : undefined;
      const formattedMessage = formatDiscordMessage(message);

      return {
        output: [
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
