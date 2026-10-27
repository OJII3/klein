import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { AgentEvent } from "./agent-event";

export interface ChannelAgent {
  prompt(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void>;
  promptEvent(event: AgentEvent, ownerMemory?: string): Promise<void>;
  steer(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void>;
  compactForHandoff(): Promise<string> | undefined;
  dispose(): void;
}
