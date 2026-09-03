import type { DiscordMessage } from "../domain/discord-message.js";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;

export interface DiscordService {
  start(onMessage: DiscordMessageHandler): Promise<void>;
  stopAccepting(): void;
  sendMessage(channelId: string, content: string): Promise<void>;
  stop(): Promise<void>;
}
