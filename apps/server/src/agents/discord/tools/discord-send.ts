import { Type } from "typebox";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { PROMISE_BLOCK_ERROR, type PromiseGuard } from "../../tools/promise-guard";
import { defineSurfaceTool } from "./surface-tool";

export function createDiscordSendTool(
  channelApi: Pick<DiscordChannelApi, "sendMessage" | "sendTyping">,
  channelId: Parameters<DiscordChannelApi["sendMessage"]>[0],
  guard?: PromiseGuard,
  onMessageSent?: () => void,
) {
  return defineSurfaceTool(
    {
      name: "discord_send",
      label: "Send Discord Message",
      exposure: "direct",
      description:
        "Send a user-visible message to the current Discord conversation. " +
        "For structured data (schedules, comparisons, metrics, logs), load discord_send_card with tool_search and send it alongside the spoken line.",
      parameters: Type.Object({
        content: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const decision = await guard?.check(params.content);
        if (decision?.action === "block") {
          throw new Error(PROMISE_BLOCK_ERROR);
        }
        await channelApi.sendTyping(channelId);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
        const sent = await channelApi.sendMessage(channelId, params.content);
        const messageIds = Array.isArray(sent) ? sent : [];
        onMessageSent?.();

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
    },
    { primary: true, outcome: "Sent a message to Discord." },
  );
}
