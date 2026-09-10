import type { AgentDefinition } from "./agent-definition.js";
import type { AgentRuntime } from "./agent-runtime.js";

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
