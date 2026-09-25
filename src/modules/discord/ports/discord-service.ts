import type { DiscordMessage, DiscordMessageLocator } from "../domain/discord-message";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;

export interface DiscordService {
  start(onMessage: DiscordMessageHandler): Promise<void>;
  stopAccepting(): void;
  setActivity(name: string): void;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<void>;
  readMessage(locator: DiscordMessageLocator): Promise<DiscordMessage>;
  stop(): Promise<void>;
}
