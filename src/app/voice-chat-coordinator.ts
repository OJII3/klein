import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type {
  VoiceChatConversation,
  VoiceChatConversationContext,
  VoiceChatConversationFactory,
} from "@modules/discord/ports/voice-chat-conversation";
import type { VoiceReactionSelector } from "@modules/discord/ports/voice-reaction-selector";

export interface VoiceChatCoordinatorDependencies {
  readonly createVoiceChatAgent: (
    channelId: string,
    sessionKey: string,
    speak: (text: string) => Promise<void>,
  ) => Promise<DiscordAgent>;
  readonly logger: Logger;
  readonly reactionSelector?: VoiceReactionSelector;
}

export class VoiceChatCoordinator implements VoiceChatConversationFactory {
  private readonly logger: Logger;

  constructor(private readonly dependencies: VoiceChatCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "voice-chat-coordinator" });
  }

  async create(context: VoiceChatConversationContext): Promise<VoiceChatConversation> {
    const sessionKey = `discord-voice:${context.guildId}:${context.voiceChannelId}:${randomUUID()}`;
    const logger = this.logger.child({
      sessionKey,
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      channelId: context.channelId,
      userId: context.user.id,
    });
    let speakCallCount = 0;
    logger.info({ event: "voice_chat_agent_creating" }, "Creating the voice conversation agent");
    const agent = await this.dependencies.createVoiceChatAgent(
      context.channelId,
      sessionKey,
      async (text) => {
        speakCallCount += 1;
        logger.info(
          { event: "voice_chat_speak_called", textLength: text.length },
          "The voice agent requested a spoken reply",
        );
        await context.speak(text);
      },
    );
    logger.info({ event: "voice_chat_agent_ready" }, "Voice conversation agent is ready");
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let processing = Promise.resolve();
    let activeReaction: AbortController | undefined;
    let lastReaction: string | undefined;
    const recentTranscripts: string[] = [];
    const playReaction = context.playReaction;
    const unsubscribeSpeechStart = context.onSpeechStart?.(() => activeReaction?.abort());

    return {
      handleTranscript: (text) => {
        if (stopped) return Promise.resolve();
        activeReaction?.abort();
        logger.info(
          { event: "voice_chat_transcript_queued", textLength: text.length },
          "Queued a voice transcript for the agent",
        );
        const next = processing.then(async () => {
          if (stopped) return;
          const startedAt = performance.now();
          const previousSpeakCallCount = speakCallCount;
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
            logger.info(
              { event: "voice_chat_message_processing_started", messageId: message.id },
              "Processing a voice transcript with the agent",
            );
            const reactionController = new AbortController();
            activeReaction = reactionController;
            const history = recentTranscripts.slice(-3);
            recentTranscripts.push(text);
            if (recentTranscripts.length > 3) recentTranscripts.shift();
            if (this.dependencies.reactionSelector && playReaction) {
              void (async () => {
                const timeout = setTimeout(() => reactionController.abort(), 600);
                try {
                  let reaction: string | undefined;
                  try {
                    reaction = await this.dependencies.reactionSelector!.select(
                      { text, recentTranscripts: history, lastReaction },
                      reactionController.signal,
                    );
                  } finally {
                    clearTimeout(timeout);
                  }
                  if (reactionController.signal.aborted || reaction === undefined) return;
                  const played = await playReaction(reaction, reactionController.signal);
                  if (played && !reactionController.signal.aborted) lastReaction = reaction;
                } catch (error) {
                  logger.warn(
                    { err: error, event: "voice_chat_reaction_failed", messageId: message.id },
                    "Failed to select or play a voice reaction",
                  );
                } finally {
                  clearTimeout(timeout);
                }
              })();
            }
            try {
              await agent.prompt(message);
            } finally {
              reactionController.abort();
              if (activeReaction === reactionController) activeReaction = undefined;
            }
            logger.info(
              {
                event: "voice_chat_message_processed",
                messageId: message.id,
                durationMs: Math.round(performance.now() - startedAt),
                speakCallCount: speakCallCount - previousSpeakCallCount,
              },
              "Processed a voice transcript",
            );
          } catch (error) {
            logger.error(
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
              logger.error(
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
        activeReaction?.abort();
        unsubscribeSpeechStart?.();
        stopPromise = processing.finally(() => agent.dispose());
        return stopPromise;
      },
    };
  }
}
