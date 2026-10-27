import type { AgentEvent } from "./agent-event";

export interface AgentEventRouter {
  listTargets(): readonly string[];
  dispatch(targetAgentId: string, event: AgentEvent): Promise<void>;
}
