import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type {
  VoiceChatConversation,
  VoiceChatConversationContext,
  VoiceChatConversationFactory,
} from "@modules/discord/ports/voice-chat-conversation";

export interface VoiceChatCoordinatorDependencies {
  readonly createVoiceChatAgent: (channelId: string, sessionKey: string) => Promise<DiscordAgent>;
  readonly logger: Logger;
}

export class VoiceChatCoordinator implements VoiceChatConversationFactory {
  private readonly logger: Logger;

  constructor(private readonly dependencies: VoiceChatCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "voice-chat-coordinator" });
  }

  async create(context: VoiceChatConversationContext): Promise<VoiceChatConversation> {
    const sessionKey = `discord-voice:${context.guildId}:${context.voiceChannelId}:${randomUUID()}`;
    const agent = await this.dependencies.createVoiceChatAgent(context.channelId, sessionKey);
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let processing = Promise.resolve();

    return {
      handleTranscript: (text) => {
        if (stopped) return Promise.resolve();
        const next = processing.then(async () => {
          if (stopped) return;
          const message: DiscordMessage = {
            author: context.user,
            channelId: context.channelId,
            content: text,
            guildId: context.guildId,
            id: randomUUID(),
            images: [],
            parentChannelId: context.parentChannelId,
            threadId: context.threadId,
          };

          try {
            const response = await agent.promptForResponse(message);
            if (response?.trim()) await context.speak(response);
          } catch (error) {
            this.logger.error(
              {
                channelId: context.channelId,
                err: error,
                event: "voice_chat_message_processing_failed",
              },
              "Failed to process a voice chat message",
            );
            try {
              await context.speak("ごめん、今はうまく返答できないみたい。");
            } catch (sendError) {
              this.logger.error(
                {
                  channelId: context.channelId,
                  err: sendError,
                  event: "voice_chat_error_response_failed",
                },
                "Failed to speak a voice chat error response",
              );
            }
          }
        });
        processing = next;
        return next;
      },
      stop: () => {
        if (stopPromise) return stopPromise;
        stopped = true;
        stopPromise = processing.finally(() => agent.dispose());
        return stopPromise;
      },
    };
  }
}
