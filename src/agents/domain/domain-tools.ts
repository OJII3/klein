import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEventRouter } from "../core/agent-event-router";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createReminderTools } from "../discord/tools/reminder";
import { createAgentSendEventTool } from "../tools/agent-send-event";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import type { DomainAgentImageAnalyzer } from "./domain-agent";

export interface DomainAgentToolsOptions {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly channelId?: string;
  readonly channelTools?: (analyzeImage: DomainAgentImageAnalyzer) => readonly ToolRegistration[];
  readonly reminderStore?: ReminderStore;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly eventRouter?: AgentEventRouter;
}

/**
 * ドメインエージェントのツール一式を組み立てる。
 * チャンネル固有のツールは channelTools として外から渡す。
 */
export function createDomainAgentTools(
  options: DomainAgentToolsOptions,
  analyzeImage: DomainAgentImageAnalyzer,
): readonly ToolRegistration[] {
  return [
    ...(options.channelTools?.(analyzeImage) ?? []),
    ...(options.reminderStore && options.channelId
      ? createReminderTools(
          options.reminderStore,
          options.channelId,
          `owner:${options.ownerUserId}`,
        )
      : []),
    ...(options.ownerMemoryStore
      ? createOwnerMemoryTools(options.ownerMemoryStore, `agent:${options.agentId}`)
      : []),
    ...(options.eventRouter
      ? [createAgentSendEventTool(options.eventRouter, options.agentId)]
      : []),
  ];
}
