import type { AgentDefinition } from "./agent-definition";
import type { AgentRuntime } from "./agent-runtime";

export interface AgentCreationOptions {
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly initialContext?: string;
  readonly resumeExistingSession?: boolean;
}

export interface AgentFactory {
  create<TTool>(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
