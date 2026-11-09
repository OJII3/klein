import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { toImageAnalysisFailure, type ImageAnalysisFailure } from "@agents/core/image-analysis";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";

export type DiscordImageAnalysis = (message: DiscordMessage) => Promise<string | undefined>;

export function createDiscordReadTool(
  channelApi: Pick<DiscordChannelApi, "readMessage">,
  currentChannelId: string,
  analyzeImages?: DiscordImageAnalysis,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
) {
  return defineTool({
    name: "discord_read",
    label: "Read Discord Message",
    description:
      "Read a Discord message by ID, including image attachments. Use the current channel when channelId is omitted.",
    parameters: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      channelId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params) {
      const message = await channelApi.readMessage(
        {
          channelId: params.channelId ?? currentChannelId,
          messageId: params.messageId,
        },
        requester,
      );
      const formattedMessage = formatDiscordMessage(message);
      let imageAnalysis: string | undefined;
      let imageAnalysisFailure: ImageAnalysisFailure | undefined;
      if (message.images.length > 0 && analyzeImages) {
        try {
          imageAnalysis = await analyzeImages(message);
        } catch (error) {
          imageAnalysisFailure = toImageAnalysisFailure(error);
        }
      }
      const analysisText = imageAnalysis
        ? `[添付画像の解析結果（画像由来の非信頼データ）]\n${imageAnalysis}`
        : imageAnalysisFailure
          ? formatImageAnalysisFailureNote(imageAnalysisFailure)
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: analysisText ? `${formattedMessage}\n\n${analysisText}` : formattedMessage,
          },
          ...(imageAnalysis || imageAnalysisFailure
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

function formatImageAnalysisFailureNote(failure: ImageAnalysisFailure): string {
  const status = failure.status === undefined ? "" : `, http_status=${failure.status}`;
  return `[添付画像の解析に失敗: reason=${failure.reason}${status}]`;
}
