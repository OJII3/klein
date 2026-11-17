import type { AgentEvent } from "./agent-event";
import type { AgentTurn, AgentTurnContext } from "./agent-turn";

/**
 * An agent that belongs to one conversation and owns its surface. The
 * conversation coordinator drives it with events and keeps its session alive.
 */
export interface ConversationAgent {
  prompt(turn: AgentTurn): Promise<void>;
  promptEvent(event: AgentEvent, context?: AgentTurnContext): Promise<void>;
  steer(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  compactForHandoff(): Promise<string> | undefined;
  dispose(): void;
}
