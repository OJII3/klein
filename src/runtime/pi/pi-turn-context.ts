import type { ContextEvent, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { AgentTurnContext } from "@agents/core/agent-turn";

export const TURN_CONTEXT_CUSTOM_TYPE = "klein-turn-context";

interface TurnContextEntryData {
  readonly content?: string;
}

export function renderTurnContext(context: AgentTurnContext): string | undefined {
  const formatted = [
    context.ownerMemory ? `<owner-memory>\n${context.ownerMemory}\n</owner-memory>` : undefined,
    context.userMemory ? `<user-memory>\n${context.userMemory}\n</user-memory>` : undefined,
    context.guildMemory ? `<guild-memory>\n${context.guildMemory}\n</guild-memory>` : undefined,
    context.channelRule ? `<channel-rule>\n${context.channelRule}\n</channel-rule>` : undefined,
  ]
    .filter((block): block is string => block !== undefined)
    .join("\n\n");

  return formatted || undefined;
}

/**
 * Injects the newest turn context into the request without keeping it in the transcript. The
 * context is recorded as a custom entry, so the viewer can show it, but only the current turn's
 * entry is read. An entry with no content clears the context for that turn.
 */
export function createTurnContextExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event, ctx) => {
      const latest = ctx.sessionManager
        .getBranch()
        .findLast(
          (entry) => entry.type === "custom" && entry.customType === TURN_CONTEXT_CUSTOM_TYPE,
        );
      if (!latest) return;

      const messages = event.messages.filter(
        (message) =>
          !(message.role === "custom" && message.customType === TURN_CONTEXT_CUSTOM_TYPE),
      );
      const content = readTurnContextEntry(latest);
      if (!content) {
        return messages.length === event.messages.length ? undefined : { messages };
      }

      const contextMessage: ContextEvent["messages"][number] = {
        role: "custom",
        customType: TURN_CONTEXT_CUSTOM_TYPE,
        content,
        display: false,
        timestamp: Date.now(),
      };
      const index = messages.findLastIndex((message) => message.role === "user");
      const next = [...messages];
      next.splice(index === -1 ? next.length : index, 0, contextMessage);
      return { messages: next };
    });
  };
}

function readTurnContextEntry(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== TURN_CONTEXT_CUSTOM_TYPE) return undefined;
  const data = entry.data as TurnContextEntryData | undefined;
  return typeof data?.content === "string" && data.content.length > 0 ? data.content : undefined;
}
