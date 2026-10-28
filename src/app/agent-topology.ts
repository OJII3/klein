import { resolve } from "node:path";
import { Check } from "typebox/value";

import { AgentIdSchema, DiscordIdSchema, type AppConfig } from "./config-schema";
import type { ConversationKey } from "./channel-session-state-store";

export const COMMUNICATION_AGENT_ID = "communication";

export type OwnerConfig = NonNullable<AppConfig["owner"]>;

export interface DomainAgentTopology {
  readonly agentId: string;
  readonly conversationKey: Extract<ConversationKey, { kind: "agent" }>;
  readonly channelId?: string;
  readonly promptFile: string;
}

export interface AgentTopology {
  readonly communicationChannelId?: string;
  readonly agents: ReadonlyMap<string, DomainAgentTopology>;
  readonly agentsByChannelId: ReadonlyMap<string, DomainAgentTopology>;
  readonly ownerChannelIds: readonly string[];
}

export function buildAgentTopology(ownerConfig: OwnerConfig | undefined): AgentTopology {
  const communicationChannelId = ownerConfig?.discord.communicationChannelId;
  const agents = new Map<string, DomainAgentTopology>();
  const agentsByChannelId = new Map<string, DomainAgentTopology>();
  const channels = new Map<string, string>();

  if (communicationChannelId !== undefined) {
    assertDiscordId(communicationChannelId, "owner.discord.communicationChannelId");
    channels.set(communicationChannelId, COMMUNICATION_AGENT_ID);
  }

  for (const [agentId, configuration] of Object.entries(ownerConfig?.agents ?? {})) {
    if (!Check(AgentIdSchema, agentId)) {
      throw new Error(`Invalid domain agent ID "${agentId}"`);
    }
    if (agentId === COMMUNICATION_AGENT_ID) {
      throw new Error(`Domain agent ID "${COMMUNICATION_AGENT_ID}" is reserved`);
    }
    if (typeof configuration.promptFile !== "string" || !configuration.promptFile.trim()) {
      throw new Error(`Domain agent "${agentId}" must configure a prompt file`);
    }

    if (configuration.channelId !== undefined) {
      assertDiscordId(configuration.channelId, `owner.agents.${agentId}.channelId`);
      const existingAgentId = channels.get(configuration.channelId);
      if (existingAgentId) {
        throw new Error(
          `Discord channel ID "${configuration.channelId}" is assigned to both "${existingAgentId}" and "${agentId}"`,
        );
      }
    }

    const agent: DomainAgentTopology = {
      agentId,
      conversationKey: { kind: "agent", agentId },
      ...(configuration.channelId !== undefined ? { channelId: configuration.channelId } : {}),
      promptFile: resolve(configuration.promptFile),
    };
    agents.set(agentId, agent);
    if (configuration.channelId !== undefined) {
      channels.set(configuration.channelId, agentId);
      agentsByChannelId.set(configuration.channelId, agent);
    }
  }

  return {
    ...(communicationChannelId ? { communicationChannelId } : {}),
    agents,
    agentsByChannelId,
    ownerChannelIds: [...channels.keys()],
  };
}

function assertDiscordId(value: string, path: string): void {
  if (!Check(DiscordIdSchema, value)) {
    throw new Error(`${path} must match the Discord ID schema`);
  }
}
