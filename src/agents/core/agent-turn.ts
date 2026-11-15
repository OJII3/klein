import type { AgentEvent } from "./agent-event";

/**
 * Reference material for one turn, kept separate from the event so the event stays a faithful
 * record of what happened. The runtime decides how to present it to the model.
 */
export interface AgentTurnContext {
  readonly ownerMemory?: string;
  readonly userMemory?: string;
  readonly guildMemory?: string;
  readonly channelRule?: string;
  /** The Discord user whose message started this turn, when a user started it. */
  readonly requesterUserId?: string;
}

export interface AgentTurn {
  readonly event: AgentEvent;
  readonly context: AgentTurnContext;
}
