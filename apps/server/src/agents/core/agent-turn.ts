import type { AgentEvent } from "./agent-event";

export const TURN_MARKER_CUSTOM_TYPE = "klein-turn";

export interface AgentContextBlock {
  /** Element name the runtime wraps the content in. */
  readonly name: string;
  readonly content: string;
}

/**
 * Reference material for one turn, kept separate from the event so the event stays a faithful
 * record of what happened. The runtime decides how to present it to the model.
 */
export interface AgentTurnContext {
  readonly userMemory?: string;
  readonly blocks?: readonly AgentContextBlock[];
  readonly requesterId?: string;
}

export interface AgentTurn {
  readonly event: AgentEvent;
  readonly context: AgentTurnContext;
}
