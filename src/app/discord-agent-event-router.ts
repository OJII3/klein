import type { Logger } from "pino";

import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentEventRouter } from "@agents/core/agent-event-router";
import type { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { TaskCoordinator } from "./task-coordinator";
import type { ChannelSessionManager } from "./channel-session-manager";
import type { ChannelSessionState } from "./channel-session-state-store";
import type { DomainAgentRegistration } from "./agent-system";

export const COMMUNICATION_AGENT_ID = "communication";

export interface DiscordAgentEventRouterDependencies {
  readonly communicationChannelId?: string;
  readonly domainAgents?: Readonly<Record<string, DomainAgentRegistration>>;
  readonly getSessionManager: () => ChannelSessionManager;
  readonly logger: Logger;
  readonly operatingState: DiscordOperatingState;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly ownerUserId?: string;
  readonly taskCoordinator: TaskCoordinator;
}

export class DiscordAgentEventRouter implements AgentEventRouter {
  private readonly domainAgentByChannelId = new Map<
    string,
    { readonly agentId: string; readonly registration: DomainAgentRegistration }
  >();
  private readonly domainChannelIds = new Set<string>();

  constructor(private readonly dependencies: DiscordAgentEventRouterDependencies) {
    for (const [agentId, registration] of Object.entries(dependencies.domainAgents ?? {})) {
      const channelKey = registration.channelId ?? `domain-agent:${agentId}`;
      this.domainAgentByChannelId.set(channelKey, { agentId, registration });
      if (registration.channelId) {
        this.domainChannelIds.add(registration.channelId);
      }
    }
  }

  listTargets(): readonly string[] {
    return [COMMUNICATION_AGENT_ID, ...Object.keys(this.dependencies.domainAgents ?? {})];
  }

  async dispatch(targetAgentId: string, event: AgentEvent): Promise<void> {
    if (!this.dependencies.operatingState.isActive()) return;
    if (
      targetAgentId !== COMMUNICATION_AGENT_ID &&
      !this.dependencies.domainAgents?.[targetAgentId]
    ) {
      throw new Error(
        `Unknown target agent "${targetAgentId}". Available targets: ${this.listTargets().join(", ")}`,
      );
    }

    void this.dependencies.taskCoordinator.run(() => this.deliverAgentEvent(targetAgentId, event));
  }

  private async deliverAgentEvent(targetAgentId: string, event: AgentEvent): Promise<void> {
    if (!this.dependencies.operatingState.isActive() || !this.dependencies.ownerUserId) return;

    const sessionManager = this.dependencies.getSessionManager();
    const channelKey = await this.resolveTargetChannelKey(targetAgentId);
    if (!channelKey) {
      this.dependencies.logger.warn(
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

    await sessionManager.runForChannel(channelKey, async () => {
      if (!this.dependencies.operatingState.isActive()) return;
      const now = Date.now();
      const accessScope = `owner:${this.dependencies.ownerUserId}`;
      let channelState: ChannelSessionState | undefined;

      try {
        channelState = await sessionManager.getChannelState(channelKey, now, accessScope);
        channelState = await sessionManager.rotateChannelIfDue(channelKey, channelState, now);
        const agent = await sessionManager.getDiscordAgent(channelKey, channelState);
        channelState = {
          ...channelState,
          handoffContext: undefined,
          hasActivitySinceRotation: true,
          lastActivityAt: now,
        };
        await sessionManager.saveChannelState(channelState);

        const ownerMemory = await this.dependencies.ownerMemoryStore?.getContext(
          buildEventMemoryQuery(event),
        );
        await agent.promptEvent(event, ownerMemory);
        this.dependencies.logger.info(
          {
            channelId: channelKey,
            event: "agent_event_delivered",
            eventId: event.id,
            eventType: event.type,
            source: event.source,
            targetAgentId,
          },
          "Delivered inter-agent event",
        );
      } catch (error) {
        this.dependencies.logger.error(
          {
            channelId: channelKey,
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
            await sessionManager.saveChannelState({
              ...channelState,
              hasActivitySinceRotation: true,
              lastActivityAt: Date.now(),
            });
          } catch (error) {
            this.dependencies.logger.error(
              { err: error, event: "channel_session_state_save_failed" },
              "Failed to save channel session state after agent event",
            );
          }
        }
      }
    });
  }

  private async resolveTargetChannelKey(targetAgentId: string): Promise<string | undefined> {
    const sessionManager = this.dependencies.getSessionManager();
    if (targetAgentId === COMMUNICATION_AGENT_ID) {
      return (
        this.dependencies.communicationChannelId ??
        (await sessionManager.findLatestOwnerChannelId(this.domainChannelIds))
      );
    }
    const domainRegistration = this.dependencies.domainAgents?.[targetAgentId];
    if (!domainRegistration) return undefined;
    return domainRegistration.channelId ?? `domain-agent:${targetAgentId}`;
  }
}

function buildEventMemoryQuery(event: AgentEvent): string {
  return event.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
