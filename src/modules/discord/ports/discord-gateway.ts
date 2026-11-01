import type { DiscordMessage } from "../domain/discord-message";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;

/**
 * Discord Gateway への常時接続と presence を持つ境界。
 * Durable Object では保持できない部分として扱う。
 */
export interface DiscordGateway {
  start(onMessage: DiscordMessageHandler): Promise<void>;
  stopAccepting(): void;
  setActivity(name: string): void;
  stop(): Promise<void>;
}
