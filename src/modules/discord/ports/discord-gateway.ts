import type { DiscordMessage } from "../domain/discord-message";
import type { DiscordReactionEvent } from "../domain/discord-reaction";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;
export type DiscordReactionHandler = (reaction: DiscordReactionEvent) => Promise<void>;

/**
 * Discord Gateway への常時接続と presence を持つ境界。
 * Durable Object では保持できない部分として扱う。
 */
export interface DiscordGateway {
  start(onMessage: DiscordMessageHandler, onReaction?: DiscordReactionHandler): Promise<void>;
  stopAccepting(): void;
  setActivity(name: string): void;
  stop(): Promise<void>;
}
