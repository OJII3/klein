export interface DiscordChannel {
  send(content: string): Promise<unknown>;
}

export interface DiscordService {
  sendMessage(channel: DiscordChannel, content: string): Promise<void>;
}
