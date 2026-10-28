import type { AgentOutputSink, AgentPrompt } from "../core/agent-runtime";
import type { DomainAgentImageAnalyzer } from "../domain/domain-agent";
import { formatDiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import { createDiscordReadTool } from "./tools/discord-read";

const DISCORD_MAX_MESSAGE_LENGTH = 2_000;
const NO_ACTION_TOKEN = "NO_ACTION";

export interface DomainAgentDiscordAdapter {
  readonly outputSink: AgentOutputSink;
  readonly channelTools: (
    analyzeImage: DomainAgentImageAnalyzer,
  ) => ReturnType<typeof createDiscordReadTool>[];
}

export function createDomainAgentDiscordAdapter(
  discordService: DiscordService,
  channelId: string,
  ownerUserId: string,
): DomainAgentDiscordAdapter {
  return {
    outputSink: {
      async writeAssistantText(text) {
        const response = text.trim();
        if (!response || response === NO_ACTION_TOKEN) return;

        for (const chunk of splitDiscordMessage(response)) {
          await discordService.sendMessage(channelId, chunk);
        }
      },
    },
    channelTools: (analyzeImage) => [
      createDiscordReadTool(
        discordService,
        channelId,
        (message) =>
          analyzeImage({
            text: formatDiscordMessage(message),
            images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
          } satisfies AgentPrompt),
        { userId: ownerUserId },
      ),
    ],
  };
}

export function splitDiscordMessage(
  text: string,
  maxLength = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
