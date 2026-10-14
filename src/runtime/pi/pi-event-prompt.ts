import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentImage, AgentPrompt } from "@agents/core/agent-runtime";

const EVENT_DATE_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function createPiEventPrompt(event: AgentEvent): AgentPrompt {
  const metadata = JSON.stringify({
    type: event.type,
    source: event.source,
    occurredAt: `${EVENT_DATE_FORMAT.format(new Date(event.occurredAt))} JST`,
  })
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e");
  const texts: string[] = [];
  const images: AgentImage[] = [];
  for (const block of event.content) {
    if (block.type === "text") texts.push(block.text);
    else images.push({ data: block.data, mimeType: block.mimeType });
  }

  return {
    traceId: event.id,
    text: `<event-metadata>\n${metadata}\n</event-metadata>\n\n${texts.join("\n\n")}`,
    images,
  };
}
