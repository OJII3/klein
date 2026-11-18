import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function readLastAssistantText(session: Pick<AgentSession, "messages">): string | undefined {
  const message = session.messages.toReversed().find((candidate) => candidate.role === "assistant");
  if (!message) return undefined;

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
}
