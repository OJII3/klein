import type { AgentEvent } from "./agent-event";

export interface AgentTurnContext {
  readonly ownerMemory?: string;
  readonly guildMemory?: string;
  readonly channelRule?: string;
}

export interface AgentTurn {
  readonly event: AgentEvent;
  readonly context: AgentTurnContext;
}

export function formatAgentTurn(turn: AgentTurn): AgentEvent {
  const formattedContext = [
    turn.context.ownerMemory
      ? `<owner-memory>\n${turn.context.ownerMemory}\n</owner-memory>`
      : undefined,
    turn.context.guildMemory
      ? `<guild-memory>\n${turn.context.guildMemory}\n</guild-memory>`
      : undefined,
    turn.context.channelRule
      ? `<channel-rule>\n${turn.context.channelRule}\n</channel-rule>`
      : undefined,
  ]
    .filter((context): context is string => context !== undefined)
    .join("\n\n");

  if (!formattedContext) return turn.event;

  const textIndex = turn.event.content.findIndex((block) => block.type === "text");
  if (textIndex === -1) {
    return {
      ...turn.event,
      content: [{ type: "text", text: formattedContext }, ...turn.event.content],
    };
  }

  return {
    ...turn.event,
    content: turn.event.content.map((block, index) =>
      index === textIndex && block.type === "text"
        ? { ...block, text: `${formattedContext}\n\n${block.text}` }
        : block,
    ),
  };
}
