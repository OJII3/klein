import type { AgentEvent } from "./agent-event";
import type { AgentTurn, AgentTurnContext } from "./agent-turn";
export interface ConversationAgent {
  prompt(turn: AgentTurn): Promise<void>;
  promptEvent(event: AgentEvent, context?: AgentTurnContext): Promise<void>;
  steer(turn: AgentTurn): Promise<void>;
  abort?(): Promise<void>;
  compactForHandoff(): Promise<string> | undefined;
  dispose(): void;
}
