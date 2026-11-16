import type { AgentEvent } from "./agent-event";

/** A named block of reference material the runtime presents to the model. */
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
  readonly ownerMemory?: string;
  readonly userMemory?: string;
  /** Platform-specific reference material, in the order the runtime should present it. */
  readonly blocks?: readonly AgentContextBlock[];
  /** The user who started this turn, when a user started it. */
  readonly requesterId?: string;
}

export interface AgentTurn {
  readonly event: AgentEvent;
  readonly context: AgentTurnContext;
}
