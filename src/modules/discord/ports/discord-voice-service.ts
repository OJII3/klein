import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";

export interface DiscordVoiceJoinRequest {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly requesterId: string;
}

export interface DiscordVoiceLeaveRequest {
  readonly guildId: string;
  readonly requesterId: string;
}

export interface DiscordVoiceDelegationRequest {
  readonly guildId: string;
  readonly delegationId: string;
  readonly transcript: string;
}

export interface DiscordVoiceCommandHandler {
  join(request: DiscordVoiceJoinRequest): Promise<string>;
  leave(request: DiscordVoiceLeaveRequest): Promise<string>;
}

export interface DiscordVoiceAdapterProvider {
  getVoiceAdapter(guildId: string): DiscordGatewayAdapterCreator;
  getCurrentUserId(): string | undefined;
}

export interface DiscordVoiceService extends DiscordVoiceCommandHandler {
  stop(): Promise<void>;
}
