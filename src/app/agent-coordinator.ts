import type { Logger } from "pino";

import type { ChannelAgent } from "@agents/core/channel-agent";
import { createDiscordMessageAgentTurn } from "@agents/discord/discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "@agents/discord/prompt-policy";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { DiscordChannelRuleStore } from "@modules/discord/ports/discord-channel-rule-store";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import { ownerAccessScope, PUBLIC_ACCESS_SCOPE } from "@shared/access";
import type { TaskCoordinator } from "./task-coordinator";
import type { ChannelSessionStateStore } from "./channel-session-state-store";
import { ChannelSessionManager } from "./channel-session-manager";
import { ScheduledTaskDeliveryCoordinator } from "./scheduled-task-delivery-coordinator";

export interface AgentCoordinatorDependencies {
  readonly channelApi: DiscordChannelApi;
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly ownerUserId?: string;
  readonly createDiscordAgent: (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<ChannelAgent>;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly channelRuleStore?: DiscordChannelRuleStore;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly operatingState: DiscordOperatingState;
  readonly scheduledTaskStore?: ScheduledTaskStore;
  readonly watchCheckRunner: WatchCheckRunner;
  readonly taskCoordinator: TaskCoordinator;
}

export class AgentCoordinator {
  private readonly logger: Logger;
  private readonly sessionManager: ChannelSessionManager;
  private readonly scheduledTaskDeliveryCoordinator: ScheduledTaskDeliveryCoordinator;

  constructor(private readonly dependencies: AgentCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "agent-coordinator" });

    this.sessionManager = new ChannelSessionManager({
      accessPolicy: dependencies.accessPolicy,
      channelSessionStateStore: dependencies.channelSessionStateStore,
      createAgent: (conversationKey, sessionKey, handoffContext, ownerFeaturesAllowed) =>
        dependencies.createDiscordAgent(
          conversationKey.channelId,
          sessionKey,
          handoffContext,
          ownerFeaturesAllowed,
        ),
      channelApi: dependencies.channelApi,
      logger: this.logger,
      ownerUserId: dependencies.ownerUserId,
    });
    this.scheduledTaskDeliveryCoordinator = new ScheduledTaskDeliveryCoordinator({
      accessPolicy: dependencies.accessPolicy,
      channelApi: dependencies.channelApi,
      logger: this.logger,
      operatingState: dependencies.operatingState,
      ownerMemoryStore: dependencies.ownerMemoryStore,
      ownerUserId: dependencies.ownerUserId,
      scheduledTaskStore: dependencies.scheduledTaskStore,
      watchCheckRunner: dependencies.watchCheckRunner,
      sessionManager: this.sessionManager,
      taskCoordinator: dependencies.taskCoordinator,
    });
  }

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return Promise.resolve();

    const conversationKey = { kind: "discord", channelId: message.channelId } as const;
    this.sessionManager.recordInbound(conversationKey);
    return this.dependencies.taskCoordinator.run(() =>
      this.sessionManager.runForConversation(conversationKey, () => this.processMessage(message)),
    );
  }

  async rotateIdleChannels(): Promise<void> {
    await this.sessionManager.rotateIdleChannels();
  }

  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
  }

  async deliverDueTasks(now = Date.now()): Promise<void> {
    await this.scheduledTaskDeliveryCoordinator.deliverDueTasks(now);
  }

  async dispose(): Promise<void> {
    await this.sessionManager.dispose();
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    const conversationKey = { kind: "discord", channelId: message.channelId } as const;
    const target = {
      guildId: message.guildId,
      channelId: message.parentChannelId ?? message.channelId,
      threadId: message.threadId,
      userId: message.author.id,
      userIsBot: message.author.bot,
    };
    if (this.dependencies.accessPolicy && !this.dependencies.accessPolicy.canReceive(target)) {
      return;
    }

    const ownerFeaturesAllowed =
      this.dependencies.accessPolicy?.canUseOwnerFeatures(target) ?? false;
    const accessScope =
      ownerFeaturesAllowed && this.dependencies.ownerUserId
        ? ownerAccessScope(this.dependencies.ownerUserId)
        : PUBLIC_ACCESS_SCOPE;

    const logger = this.logger.child({
      channelId: message.channelId,
      messageId: message.id,
    });
    const startedAt = Date.now();
    logger.debug({ event: "discord_message_processing_started" }, "Processing Discord message");
    try {
      await this.sessionManager.runTurn(conversationKey, accessScope, async (agent) => {
        const query = buildMemoryQuery(message);
        const guildMemory = message.guildId
          ? await this.dependencies.memoryCoordinator?.getContext(message.guildId, query)
          : undefined;
        const channelRule = message.guildId
          ? await this.dependencies.channelRuleStore?.get(message.guildId, message.channelId)
          : undefined;
        const ownerMemory = ownerFeaturesAllowed
          ? await this.dependencies.ownerMemoryStore?.getContext(query)
          : undefined;
        const turn = createDiscordMessageAgentTurn(
          message,
          { ownerMemory, guildMemory, channelRule },
          {
            botMessageGuidance: BOT_MESSAGE_GUIDANCE,
            ownerValidation:
              ownerFeaturesAllowed && this.dependencies.ownerUserId
                ? { userId: this.dependencies.ownerUserId, channelId: message.channelId }
                : undefined,
          },
        );
        await agent.prompt(turn);
        logger.debug(
          {
            durationMs: Date.now() - startedAt,
            event: "discord_message_processed",
          },
          "Processed Discord message",
        );
      });
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          err: error,
          event: "discord_message_processing_failed",
        },
        "Failed to handle Discord message",
      );
      await this.dependencies.channelApi.sendMessage(
        message.channelId,
        "ごめん、今はうまく返答できないみたい。",
      );
    } finally {
      if (!ownerFeaturesAllowed) this.dependencies.memoryCoordinator?.enqueue(message);
    }
  }
}

function buildMemoryQuery(message: DiscordMessage): string {
  return [message.content, message.replyTo?.content].filter(Boolean).join("\n");
}
