import type { Logger } from "pino";

import type { AgentEventRouter } from "@agents/core/agent-event-router";
import type { ChannelAgent } from "@agents/core/channel-agent";
import { ChannelSessionManager } from "./channel-session-manager";
import { AgentCoordinator } from "./agent-coordinator";
import { DiscordAgentEventRouter } from "./discord-agent-event-router";
import { DiscordMessageIngress } from "./discord-message-ingress";
import { ReminderDeliveryCoordinator } from "./reminder-delivery-coordinator";
import type { DiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { DiscordChannelRuleStore } from "@modules/discord/ports/discord-channel-rule-store";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import type { TaskCoordinator } from "./task-coordinator";
import type { ChannelSessionStateStore } from "./channel-session-state-store";

export interface DomainAgentRegistration {
  readonly channelId?: string;
  readonly createAgent: (
    eventRouter: AgentEventRouter,
    sessionKey: string,
    handoffContext?: string,
  ) => Promise<ChannelAgent>;
}

export interface AgentSystemDependencies {
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly agentEventRouter?: AgentEventRouter;
  readonly channelRuleStore?: DiscordChannelRuleStore;
  readonly channelSessionStateStore?: ChannelSessionStateStore;
  readonly communicationChannelId?: string;
  readonly createDiscordAgent: (
    eventRouter: AgentEventRouter,
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed?: boolean,
  ) => Promise<ChannelAgent>;
  readonly discordService: DiscordService;
  readonly domainAgents?: Readonly<Record<string, DomainAgentRegistration>>;
  readonly logger: Logger;
  readonly memoryCoordinator?: MemoryCoordinator;
  readonly operatingState: DiscordOperatingState;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly ownerUserId?: string;
  readonly reminderStore?: ReminderStore;
  readonly taskCoordinator: TaskCoordinator;
}

export interface AgentSystem {
  readonly agentCoordinator: AgentCoordinator;
  readonly agentEventRouter: AgentEventRouter;
  readonly discordMessageIngress: DiscordMessageIngress;
}

export function createAgentSystem(dependencies: AgentSystemDependencies): AgentSystem {
  const logger = dependencies.logger.child({ component: "agent-coordinator" });
  const domainAgentByChannelId = new Map<string, DomainAgentRegistration>();
  for (const registration of Object.values(dependencies.domainAgents ?? {})) {
    if (registration.channelId) domainAgentByChannelId.set(registration.channelId, registration);
  }

  let sessionManager: ChannelSessionManager;
  const agentEventRouter =
    dependencies.agentEventRouter ??
    new DiscordAgentEventRouter({
      communicationChannelId: dependencies.communicationChannelId,
      domainAgents: dependencies.domainAgents,
      getSessionManager: () => sessionManager,
      logger,
      operatingState: dependencies.operatingState,
      ownerMemoryStore: dependencies.ownerMemoryStore,
      ownerUserId: dependencies.ownerUserId,
      taskCoordinator: dependencies.taskCoordinator,
    });

  sessionManager = new ChannelSessionManager({
    accessPolicy: dependencies.accessPolicy,
    channelSessionStateStore: dependencies.channelSessionStateStore,
    createDiscordAgent: (channelId, sessionKey, handoffContext, ownerFeaturesAllowed) => {
      const domainRegistration = domainAgentByChannelId.get(channelId);
      if (domainRegistration) {
        return domainRegistration.createAgent(agentEventRouter, sessionKey, handoffContext);
      }
      return dependencies.createDiscordAgent(
        agentEventRouter,
        channelId,
        sessionKey,
        handoffContext,
        ownerFeaturesAllowed,
      );
    },
    discordService: dependencies.discordService,
    logger,
    ownerUserId: dependencies.ownerUserId,
  });

  const reminderDeliveryCoordinator = new ReminderDeliveryCoordinator({
    accessPolicy: dependencies.accessPolicy,
    discordService: dependencies.discordService,
    logger,
    operatingState: dependencies.operatingState,
    ownerMemoryStore: dependencies.ownerMemoryStore,
    ownerUserId: dependencies.ownerUserId,
    reminderStore: dependencies.reminderStore,
    sessionManager,
    taskCoordinator: dependencies.taskCoordinator,
  });
  const agentCoordinator = new AgentCoordinator(sessionManager, reminderDeliveryCoordinator);
  const discordMessageIngress = new DiscordMessageIngress({
    accessPolicy: dependencies.accessPolicy,
    channelRuleStore: dependencies.channelRuleStore,
    discordService: dependencies.discordService,
    domainAgents: dependencies.domainAgents,
    logger,
    memoryCoordinator: dependencies.memoryCoordinator,
    operatingState: dependencies.operatingState,
    ownerMemoryStore: dependencies.ownerMemoryStore,
    ownerUserId: dependencies.ownerUserId,
    sessionManager,
    taskCoordinator: dependencies.taskCoordinator,
  });

  return { agentCoordinator, agentEventRouter, discordMessageIngress };
}
