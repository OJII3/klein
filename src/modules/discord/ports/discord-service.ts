import type { DiscordMessage, DiscordMessageLocator } from "../domain/discord-message.js";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;

export interface DiscordService {
  start(onMessage: DiscordMessageHandler): Promise<void>;
  stopAccepting(): void;
  sendMessage(channelId: string, content: string): Promise<void>;
  readMessage(locator: DiscordMessageLocator): Promise<DiscordMessage>;
  stop(): Promise<void>;
}
