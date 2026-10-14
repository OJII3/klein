import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentPrompt } from "@agents/core/agent-runtime";

export function createPiEventPrompt(event: AgentEvent): AgentPrompt {
  const metadata = JSON.stringify({
    id: event.id,
    type: event.type,
    source: event.source,
    data: event.data,
  })
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e");

  return {
    traceId: event.id,
    ownerFeaturesAllowed: event.ownerFeaturesAllowed,
    text: `<event-metadata>\n${metadata}\n</event-metadata>\n\n${event.text}`,
    images: event.images,
  };
}
