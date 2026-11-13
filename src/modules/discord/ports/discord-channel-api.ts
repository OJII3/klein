import type { DiscordMessage, DiscordMessageLocator } from "../domain/discord-message";

export interface DiscordMessageRequester {
  readonly userId: string;
  readonly userIsBot?: boolean;
}

export interface DiscordChannelLocation {
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly channelName?: string;
}

/**
 * Discord への読み書きだけを持つ境界。
 * Gateway 接続や operating state には依存しない。
 */
export interface DiscordChannelApi {
  getChannelLocation(channelId: string): Promise<DiscordChannelLocation>;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<readonly string[] | void>;
  sendAudio(channelId: string, audio: Uint8Array, filename: string): Promise<void>;
  readMessage(
    locator: DiscordMessageLocator,
    requester?: DiscordMessageRequester,
  ): Promise<DiscordMessage>;
}
