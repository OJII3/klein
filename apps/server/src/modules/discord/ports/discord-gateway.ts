import type { DiscordMessage } from "../domain/discord-message";
import type { DiscordReactionEvent } from "../domain/discord-reaction";

export type DiscordMessageHandler = (message: DiscordMessage) => Promise<void>;
export type DiscordReactionHandler = (reaction: DiscordReactionEvent) => Promise<void>;

export interface DiscordGateway {
  start(onMessage: DiscordMessageHandler, onReaction?: DiscordReactionHandler): Promise<void>;
  stopAccepting(): void;
  setActivity(name: string): void;
  stop(): Promise<void>;
}
