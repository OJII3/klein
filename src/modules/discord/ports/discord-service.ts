import type { DiscordAccessTarget } from "../domain/discord-access-policy";
import type { DiscordMessage, DiscordMessageLocator } from "../domain/discord-message";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;

export interface DiscordMessageRequester {
  readonly userId: string;
  readonly userIsBot?: boolean;
}

export interface DiscordService {
  start(onMessage: DiscordMessageHandler): Promise<void>;
  stopAccepting(): void;
  setActivity(name: string): void;
  getChannelLocation(
    channelId: string,
  ): Promise<Pick<DiscordAccessTarget, "guildId" | "channelId" | "threadId">>;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<void>;
  sendAudio(channelId: string, audio: Uint8Array, filename: string): Promise<void>;
  readMessage(
    locator: DiscordMessageLocator,
    requester?: DiscordMessageRequester,
  ): Promise<DiscordMessage>;
  stop(): Promise<void>;
}
