import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEventRouter } from "../core/agent-event-router";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createReminderTools } from "../discord/tools/reminder";
import { createAgentSendEventTool } from "../tools/agent-send-event";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createWatchTools } from "../tools/watch";
import type { DomainAgentImageAnalyzer } from "./domain-agent";

export interface DomainAgentToolsOptions {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly channelId?: string;
  readonly channelTools?: (analyzeImage: DomainAgentImageAnalyzer) => readonly ToolRegistration[];
  readonly scheduledTaskStore?: ScheduledTaskStore;
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
    ...(options.scheduledTaskStore && options.channelId
      ? createReminderTools(
          options.scheduledTaskStore,
          options.channelId,
          `owner:${options.ownerUserId}`,
        )
      : []),
    ...(options.scheduledTaskStore && options.channelId
      ? createWatchTools(options.scheduledTaskStore, options.channelId, options.ownerUserId)
      : []),
    ...(options.ownerMemoryStore
      ? createOwnerMemoryTools(options.ownerMemoryStore, `agent:${options.agentId}`)
      : []),
    ...(options.eventRouter
      ? [createAgentSendEventTool(options.eventRouter, options.agentId)]
      : []),
  ];
}
