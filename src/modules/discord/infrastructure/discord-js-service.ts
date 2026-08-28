import type { DiscordChannel, DiscordService } from "../ports/discord-service.js";

const DISCORD_MESSAGE_LIMIT = 2_000;

function splitMessage(content: string): string[] {
  const chunks: string[] = [];

  for (let offset = 0; offset < content.length; offset += DISCORD_MESSAGE_LIMIT) {
    chunks.push(content.slice(offset, offset + DISCORD_MESSAGE_LIMIT));
  }

  return chunks;
}

export class DiscordJsService implements DiscordService {
  async sendMessage(channel: DiscordChannel, content: string): Promise<void> {
    for (const chunk of splitMessage(content)) {
      await channel.send(chunk);
    }
  }
}
