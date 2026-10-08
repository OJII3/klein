import type { DiscordUser } from "../domain/discord-message";

export interface VoiceChatConversationContext {
  readonly channelId: string;
  readonly guildId: string;
  readonly parentChannelId?: string;
  readonly threadId?: string;
  readonly user: DiscordUser;
  readonly voiceChannelId: string;
}

export interface VoiceChatConversation {
  handleTranscript(text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceChatConversationFactory {
  create(context: VoiceChatConversationContext): Promise<VoiceChatConversation>;
}
