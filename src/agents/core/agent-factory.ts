import type { AgentDefinition } from "./agent-definition";
import type { AgentRuntime } from "./agent-runtime";

export interface AgentCreationOptions {
  readonly sessionKey: string;
}

export interface AgentFactory {
  create<TTool>(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
