import type { Logger } from "pino";

import type { ChannelAgent } from "@agents/core/channel-agent";
import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentEventRouter } from "@agents/core/agent-event-router";
import { createDiscordMessageAgentTurn } from "@agents/discord/discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "@agents/discord/prompt-policy";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { DiscordChannelRuleStore } from "@modules/discord/ports/discord-channel-rule-store";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import type { TaskCoordinator } from "./task-coordinator";
import type {
  ChannelSessionState,
  ChannelSessionStateStore,
  ConversationKey,
} from "./channel-session-state-store";
import { COMMUNICATION_AGENT_ID, type AgentTopology } from "./agent-topology";
import { ChannelSessionManager } from "./channel-session-manager";
import { ReminderDeliveryCoordinator } from "./reminder-delivery-coordinator";

export { COMMUNICATION_AGENT_ID };

export interface AgentCoordinatorDependencies {
  readonly topology: AgentTopology;
  readonly discordService: DiscordService;
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly ownerUserId?: string;
  readonly createDiscordAgent: (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<ChannelAgent>;
  readonly createDomainAgent: (
    agentId: string,
    sessionKey: string,
    handoffContext?: string,
  ) => Promise<ChannelAgent>;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly channelRuleStore?: DiscordChannelRuleStore;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly operatingState: DiscordOperatingState;
  readonly reminderStore?: ReminderStore;
  readonly taskCoordinator: TaskCoordinator;
}

export class AgentCoordinator implements AgentEventRouter {
  private readonly logger: Logger;
  private readonly sessionManager: ChannelSessionManager;
  private readonly reminderDeliveryCoordinator: ReminderDeliveryCoordinator;

  constructor(private readonly dependencies: AgentCoordinatorDependencies) {
    this.logger = dependencies.logger.child({ component: "agent-coordinator" });

    this.sessionManager = new ChannelSessionManager({
      accessPolicy: dependencies.accessPolicy,
      channelSessionStateStore: dependencies.channelSessionStateStore,
      createAgent: (conversationKey, sessionKey, handoffContext, ownerFeaturesAllowed) => {
        if (conversationKey.kind === "agent") {
          return dependencies.createDomainAgent(
            conversationKey.agentId,
            sessionKey,
            handoffContext,
          );
        }
        return dependencies.createDiscordAgent(
          conversationKey.channelId,
          sessionKey,
          handoffContext,
          ownerFeaturesAllowed,
        );
      },
      discordService: dependencies.discordService,
      isKnownAgent: (agentId) => dependencies.topology.agents.has(agentId),
      logger: this.logger,
      ownerUserId: dependencies.ownerUserId,
    });
    this.reminderDeliveryCoordinator = new ReminderDeliveryCoordinator({
      accessPolicy: dependencies.accessPolicy,
      discordService: dependencies.discordService,
      logger: this.logger,
      operatingState: dependencies.operatingState,
      ownerMemoryStore: dependencies.ownerMemoryStore,
      ownerUserId: dependencies.ownerUserId,
      reminderStore: dependencies.reminderStore,
      resolveConversationKey: (channelId) => this.resolveDiscordMessageConversationKey(channelId),
      sessionManager: this.sessionManager,
      taskCoordinator: dependencies.taskCoordinator,
    });
  }

  listTargets(): readonly string[] {
    return [COMMUNICATION_AGENT_ID, ...this.dependencies.topology.agents.keys()];
  }

  async dispatch(targetAgentId: string, event: AgentEvent): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    if (
      targetAgentId !== COMMUNICATION_AGENT_ID &&
      !this.dependencies.topology.agents.has(targetAgentId)
    ) {
      throw new Error(
        `Unknown target agent "${targetAgentId}". Available targets: ${this.listTargets().join(", ")}`,
      );
    }

    void this.dependencies.taskCoordinator.run(() => this.deliverAgentEvent(targetAgentId, event));
  }

  handleDiscordMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return Promise.resolve();

    const conversationKey = this.resolveDiscordMessageConversationKey(message.channelId);
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

  async deliverDueReminders(now = Date.now()): Promise<void> {
    await this.reminderDeliveryCoordinator.deliverDueReminders(now);
  }

  async dispose(): Promise<void> {
    await this.sessionManager.dispose();
  }

  private resolveDiscordMessageConversationKey(channelId: string): ConversationKey {
    return (
      this.dependencies.topology.agentsByChannelId.get(channelId)?.conversationKey ?? {
        kind: "discord",
        channelId,
      }
    );
  }

  private async deliverAgentEvent(targetAgentId: string, event: AgentEvent): Promise<void> {
    if (!this.dependencies.operatingState.isActive() || !this.dependencies.ownerUserId) return;

    const conversationKey = await this.resolveTargetConversationKey(targetAgentId);
    if (!conversationKey) {
      this.logger.warn(
        {
          event: "agent_event_target_channel_missing",
          eventId: event.id,
          eventType: event.type,
          targetAgentId,
        },
        "Cannot deliver agent event because target channel is not configured or active",
      );
      return;
    }

    await this.sessionManager.runForConversation(conversationKey, async () => {
      if (!this.dependencies.operatingState.isActive()) return;
      const now = Date.now();
      const accessScope = `owner:${this.dependencies.ownerUserId}`;
      let channelState: ChannelSessionState | undefined;

      try {
        channelState = await this.sessionManager.getConversationState(
          conversationKey,
          now,
          accessScope,
        );
        channelState = await this.sessionManager.rotateConversationIfDue(
          conversationKey,
          channelState,
          now,
        );
        const agent = await this.sessionManager.getAgent(conversationKey, channelState);
        channelState = {
          ...channelState,
          handoffContext: undefined,
          hasActivitySinceRotation: true,
          lastActivityAt: now,
        };
        await this.sessionManager.saveConversationState(channelState);

        const ownerMemory = await this.dependencies.ownerMemoryStore?.getContext(
          buildEventMemoryQuery(event),
        );
        await agent.promptEvent(event, { ownerMemory });
        this.logger.info(
          {
            conversationKey,
            event: "agent_event_delivered",
            eventId: event.id,
            eventType: event.type,
            source: event.source,
            targetAgentId,
          },
          "Delivered inter-agent event",
        );
      } catch (error) {
        this.logger.error(
          {
            conversationKey,
            err: error,
            event: "agent_event_delivery_failed",
            eventId: event.id,
            eventType: event.type,
            targetAgentId,
          },
          "Failed to deliver inter-agent event",
        );
      } finally {
        if (channelState) {
          try {
            await this.sessionManager.saveConversationState({
              ...channelState,
              hasActivitySinceRotation: true,
              lastActivityAt: Date.now(),
            });
          } catch (error) {
            this.logger.error(
              { err: error, event: "channel_session_state_save_failed" },
              "Failed to save channel session state after agent event",
            );
          }
        }
      }
    });
  }

  private async resolveTargetConversationKey(
    targetAgentId: string,
  ): Promise<ConversationKey | undefined> {
    if (targetAgentId === COMMUNICATION_AGENT_ID) {
      const channelId =
        this.dependencies.topology.communicationChannelId ??
        (await this.sessionManager.findLatestOwnerChannelId());
      return channelId ? { kind: "discord", channelId } : undefined;
    }
    return this.dependencies.topology.agents.get(targetAgentId)?.conversationKey;
  }

  private async processMessage(message: DiscordMessage): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    const domainAgent = this.dependencies.topology.agentsByChannelId.get(message.channelId);
    const isDomainChannel = domainAgent !== undefined;
    const conversationKey =
      domainAgent?.conversationKey ?? ({ kind: "discord", channelId: message.channelId } as const);
    const target = {
      guildId: message.guildId,
      channelId: message.parentChannelId ?? message.channelId,
      threadId: message.threadId,
      userId: message.author.id,
      userIsBot: message.author.bot,
    };
    if (isDomainChannel) {
      if (
        !this.dependencies.ownerUserId ||
        message.author.bot ||
        message.author.id !== this.dependencies.ownerUserId
      ) {
        return;
      }
    } else if (
      this.dependencies.accessPolicy &&
      !this.dependencies.accessPolicy.canReceive(target)
    ) {
      return;
    }

    const ownerFeaturesAllowed =
      isDomainChannel || (this.dependencies.accessPolicy?.canUseOwnerFeatures(target) ?? false);
    const accessScope = ownerFeaturesAllowed ? `owner:${this.dependencies.ownerUserId}` : "public";

    const logger = this.logger.child({
      channelId: message.channelId,
      messageId: message.id,
    });
    const startedAt = Date.now();
    logger.debug({ event: "discord_message_processing_started" }, "Processing Discord message");
    let channelState: ChannelSessionState | undefined;

    try {
      const now = Date.now();
      channelState = await this.sessionManager.getConversationState(
        conversationKey,
        now,
        accessScope,
      );
      channelState = await this.sessionManager.rotateConversationIfDue(
        conversationKey,
        channelState,
        now,
      );
      const agent = await this.sessionManager.getAgent(conversationKey, channelState);
      if (channelState.handoffContext) {
        channelState = { ...channelState, handoffContext: undefined };
      }
      channelState = {
        ...channelState,
        hasActivitySinceRotation: true,
        lastActivityAt: now,
      };
      await this.sessionManager.saveConversationState(channelState);

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
          botMessageGuidance: isDomainChannel ? undefined : BOT_MESSAGE_GUIDANCE,
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
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          err: error,
          event: "discord_message_processing_failed",
        },
        "Failed to handle Discord message",
      );
      await this.dependencies.discordService.sendMessage(
        message.channelId,
        "ごめん、今はうまく返答できないみたい。",
      );
    } finally {
      if (channelState) {
        try {
          await this.sessionManager.saveConversationState({
            ...channelState,
            hasActivitySinceRotation: true,
            lastActivityAt: Date.now(),
          });
        } catch (error) {
          logger.error(
            { err: error, event: "channel_session_state_save_failed" },
            "Failed to save Discord channel session state",
          );
        }
      }
      if (!ownerFeaturesAllowed) this.dependencies.memoryCoordinator?.enqueue(message);
    }
  }
}

function buildMemoryQuery(message: DiscordMessage): string {
  return [message.content, message.replyTo?.content].filter(Boolean).join("\n");
}

function buildEventMemoryQuery(event: AgentEvent): string {
  return event.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
