import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { createDiscordReadTool } from "./discord-read";

/**
 * Tools for an attached agent. The attached agent reads the conversation it
 * belongs to but never writes to the surface.
 */
export function createAttachedWorkerTools(
  channelApi: Pick<DiscordChannelApi, "readMessage">,
  channelId: string,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
): readonly ToolDefinition[] {
  return [createDiscordReadTool(channelApi, channelId, undefined, requester)];
}
