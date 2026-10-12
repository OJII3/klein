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
import type {
  VoiceTranscriptQueueAction,
  VoiceTranscriptQueueSelector,
} from "@modules/discord/ports/voice-transcript-queue-selector";

export interface VoiceChatCoordinatorDependencies {
  readonly createVoiceChatAgent: (
    channelId: string,
    sessionKey: string,
    speak: (text: string, toolCallId?: string) => Promise<void>,
  ) => Promise<DiscordAgent>;
  readonly logger: Logger;
  readonly reactionSelector?: VoiceReactionSelector;
  readonly transcriptQueueSelector?: VoiceTranscriptQueueSelector;
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
      async (text, toolCallId) => {
        speakCallCount += 1;
        logger.info(
          { event: "voice_chat_speak_called", toolCallId, textLength: text.length },
          "The voice agent requested a spoken reply",
        );
        await context.speak(text, toolCallId);
      },
    );
    logger.info({ event: "voice_chat_agent_ready" }, "Voice conversation agent is ready");
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let processing: Promise<void> | undefined;
    const pendingSteers = new Set<Promise<void>>();
    const pendingTranscripts: DiscordMessage[] = [];
    let currentTranscript: DiscordMessage | undefined;
    let queueDecisionTimer: ReturnType<typeof setTimeout> | undefined;
    let queueDecisionController: AbortController | undefined;
    let queueRevision = 0;
    let activeReaction: AbortController | undefined;
    let lastReaction: string | undefined;
    const recentTranscripts: string[] = [];
    const playReaction = context.playReaction;
    const unsubscribeSpeechStart = context.onSpeechStart?.(() => activeReaction?.abort());

    const startReaction = (text: string, messageId: string): AbortController => {
      activeReaction?.abort();
      const reactionController = new AbortController();
      activeReaction = reactionController;
      const history = recentTranscripts.slice(-3);
      recentTranscripts.push(text);
      if (recentTranscripts.length > 3) recentTranscripts.shift();
      if (!this.dependencies.reactionSelector || !playReaction) return reactionController;

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
            { err: error, event: "voice_chat_reaction_failed", messageId },
            "Failed to select or play a voice reaction",
          );
        } finally {
          clearTimeout(timeout);
        }
      })();
      return reactionController;
    };

    const processTranscript = async (
      message: DiscordMessage,
      reactionController: AbortController,
    ): Promise<void> => {
      currentTranscript = message;
      const startedAt = performance.now();
      const previousSpeakCallCount = speakCallCount;
      try {
        logger.info(
          { event: "voice_chat_message_processing_started", messageId: message.id },
          "Processing a voice transcript with the agent",
        );
        await agent.prompt(message);
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
            messageId: message.id,
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
      } finally {
        currentTranscript = undefined;
        reactionController.abort();
        if (activeReaction !== reactionController) activeReaction?.abort();
        activeReaction = undefined;
        if (pendingTranscripts.length > 0) scheduleQueueDecision();
      }
    };

    const trackProcessing = (next: Promise<void>): Promise<void> => {
      processing = next;
      void next.finally(() => {
        if (processing === next) processing = undefined;
      });
      return next;
    };

    const processNextQueuedTranscript = (): void => {
      if (stopped || processing || pendingTranscripts.length === 0) return;
      const message = pendingTranscripts.shift()!;
      const next = processTranscript(message, startReaction(message.content, message.id));
      trackProcessing(next);
      if (pendingTranscripts.length > 0) scheduleQueueDecision();
    };

    const performSteer = async (message: DiscordMessage): Promise<void> => {
      if (typeof agent.steer !== "function") return;
      const reactionController = startReaction(message.content, message.id);
      logger.info(
        {
          event: "voice_chat_transcript_steer_started",
          messageId: message.id,
          textLength: message.content.length,
        },
        "Steering the active voice response with a new transcript",
      );
      const steerStartedAt = performance.now();
      const steer = agent
        .steer(message)
        .then(() => {
          if (currentTranscript) {
            currentTranscript = {
              ...currentTranscript,
              content: `${currentTranscript.content}\n${message.content}`,
            };
          }
          logger.info(
            {
              event: "voice_chat_transcript_steered",
              messageId: message.id,
              durationMs: Math.round(performance.now() - steerStartedAt),
            },
            "Enqueued a transcript to steer the active voice response",
          );
        })
        .catch((error: unknown) => {
          logger.error(
            {
              channelId: context.channelId,
              err: error,
              event: "voice_chat_steer_failed",
              messageId: message.id,
            },
            "Failed to steer the active voice response",
          );
          reactionController.abort();
          activeReaction?.abort();
        });
      pendingSteers.add(steer);
      void steer.finally(() => pendingSteers.delete(steer));
      await steer;
    };

    const applyQueueAction = async (
      action: VoiceTranscriptQueueAction,
      revision: number,
      controller: AbortController,
    ): Promise<void> => {
      if (stopped || controller.signal.aborted || revision !== queueRevision) return;
      if (action === "discard") {
        const discarded = pendingTranscripts.shift();
        logger.info(
          {
            event: "voice_chat_transcript_discarded",
            messageId: discarded?.id,
            queueLength: pendingTranscripts.length,
          },
          "Discarded a voice transcript based on the queue classification",
        );
        scheduleQueueDecision();
        return;
      }

      if (action === "merge" && pendingTranscripts.length > 1) {
        const first = pendingTranscripts[0]!;
        const second = pendingTranscripts[1]!;
        pendingTranscripts.splice(0, 2, {
          ...first,
          content: `${first.content}\n${second.content}`,
        });
        logger.info(
          {
            event: "voice_chat_transcripts_merged",
            messageId: first.id,
            queueLength: pendingTranscripts.length,
          },
          "Merged adjacent voice transcripts based on the queue classification",
        );
        scheduleQueueDecision();
        return;
      }

      if (action === "steer" && typeof agent.steer === "function") {
        const message = pendingTranscripts.shift();
        if (message) await performSteer(message);
        scheduleQueueDecision();
        return;
      }

      if (!processing) processNextQueuedTranscript();
    };

    const decideTranscriptQueue = async (
      revision: number,
      controller: AbortController,
    ): Promise<void> => {
      const selector = this.dependencies.transcriptQueueSelector;
      if (!selector || stopped || controller.signal.aborted || pendingTranscripts.length === 0) {
        return;
      }
      if (!processing) {
        processNextQueuedTranscript();
        return;
      }

      let action: VoiceTranscriptQueueAction;
      try {
        action = await selector.select(
          {
            currentTranscript: currentTranscript?.content ?? "",
            queuedTranscripts: pendingTranscripts.map((message) => message.content),
          },
          controller.signal,
        );
      } catch {
        action = "keep";
      }
      if (controller.signal.aborted || revision !== queueRevision || stopped) return;
      await applyQueueAction(action, revision, controller);
    };

    const scheduleQueueDecision = (): void => {
      if (
        !this.dependencies.transcriptQueueSelector ||
        stopped ||
        pendingTranscripts.length === 0
      ) {
        return;
      }
      queueRevision += 1;
      queueDecisionController?.abort();
      queueDecisionController = undefined;
      if (queueDecisionTimer) clearTimeout(queueDecisionTimer);
      const revision = queueRevision;
      const controller = new AbortController();
      queueDecisionController = controller;
      queueDecisionTimer = setTimeout(
        () => {
          queueDecisionTimer = undefined;
          void decideTranscriptQueue(revision, controller).finally(() => {
            if (queueDecisionController === controller) queueDecisionController = undefined;
          });
        },
        processing ? 80 : 0,
      );
    };

    return {
      handleTranscript: (text, requestId) => {
        if (stopped) return Promise.resolve();
        const message: DiscordMessage = {
          author: context.user,
          channelId: context.channelId,
          content: text,
          guildId: context.guildId,
          id: requestId ?? randomUUID(),
          images: [],
          parentChannelId: context.parentChannelId,
          threadId: context.threadId,
        };
        logger.info(
          {
            event: "voice_chat_transcript_received",
            messageId: message.id,
            textLength: text.length,
            processing: processing !== undefined,
          },
          "Received a voice transcript",
        );
        if (this.dependencies.transcriptQueueSelector) {
          if (processing || pendingTranscripts.length > 0) {
            pendingTranscripts.push(message);
            logger.info(
              {
                event: "voice_chat_transcript_queued",
                messageId: message.id,
                queueLength: pendingTranscripts.length,
              },
              "Queued a voice transcript for classification",
            );
            scheduleQueueDecision();
            return Promise.resolve();
          }

          const reactionController = startReaction(text, message.id);
          const next = processTranscript(message, reactionController);
          trackProcessing(next);
          return typeof agent.steer === "function" ? Promise.resolve() : next;
        }

        if (processing && typeof agent.steer !== "function") {
          const next = processing.then(() =>
            processTranscript(message, startReaction(text, message.id)),
          );
          return trackProcessing(next);
        }

        const reactionController = startReaction(text, message.id);
        if (processing) {
          logger.info(
            {
              event: "voice_chat_transcript_steer_started",
              messageId: message.id,
              textLength: text.length,
            },
            "Steering the active voice response with a new transcript",
          );
          const steerStartedAt = performance.now();
          const steer = agent.steer!(message)
            .then(() => {
              logger.info(
                {
                  event: "voice_chat_transcript_steered",
                  messageId: message.id,
                  durationMs: Math.round(performance.now() - steerStartedAt),
                },
                "Enqueued a transcript to steer the active voice response",
              );
            })
            .catch((error: unknown) => {
              logger.error(
                {
                  channelId: context.channelId,
                  err: error,
                  event: "voice_chat_steer_failed",
                  messageId: message.id,
                },
                "Failed to steer the active voice response",
              );
              activeReaction?.abort();
            });
          pendingSteers.add(steer);
          void steer.finally(() => pendingSteers.delete(steer));
          return steer;
        }

        const next = processTranscript(message, reactionController);
        trackProcessing(next);
        return typeof agent.steer === "function" ? Promise.resolve() : next;
      },
      stop: () => {
        if (stopPromise) return stopPromise;
        stopped = true;
        if (queueDecisionTimer) clearTimeout(queueDecisionTimer);
        queueDecisionController?.abort();
        pendingTranscripts.length = 0;
        activeReaction?.abort();
        unsubscribeSpeechStart?.();
        stopPromise = Promise.allSettled(pendingSteers)
          .then(() => processing)
          .then(() => agent.dispose());
        return stopPromise;
      },
    };
  }
}
