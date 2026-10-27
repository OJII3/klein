import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentEventRouter } from "@agents/core/agent-event-router";

export function createAgentSendEventTool(router: AgentEventRouter, sourceAgentId: string) {
  return defineTool({
    name: "agent_send_event",
    description:
      "Send an asynchronous event to another agent (use targetAgent='communication' for the owner's communication agent, or a configured domain agent ID).",
    parameters: Type.Object({
      targetAgent: Type.String({ minLength: 1, maxLength: 100 }),
      eventType: Type.String({ minLength: 1, maxLength: 100 }),
      message: Type.String({ minLength: 1, maxLength: 10_000 }),
    }),
    deferred: true,
    async execute(params) {
      const targetAgent = params.targetAgent.trim();
      const eventType = params.eventType.trim();
      const message = params.message.trim();
      if (!targetAgent || !eventType || !message) {
        throw new Error("targetAgent, eventType, and message must not be empty.");
      }

      const event: AgentEvent = {
        id: randomUUID(),
        type: eventType,
        source: `agent:${sourceAgentId}`,
        occurredAt: new Date().toISOString(),
        content: [{ type: "text", text: message }],
      };

      await router.dispatch(targetAgent, event);

      return {
        output: [
          {
            type: "text",
            text: `イベント (${eventType}) をエージェント "${targetAgent}" に送信しました。ID: ${event.id}`,
          },
        ],
        details: {
          id: event.id,
          targetAgent,
          eventType,
        },
      };
    },
  });
}
