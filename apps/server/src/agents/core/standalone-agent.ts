import type { AgentDefinition } from "./agent-definition";
import type { AgentTool } from "./agent-tool";

export interface StandaloneAgentPromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface StandaloneAgent {
  prompt(text: string, options?: StandaloneAgentPromptOptions): Promise<string | undefined>;
  dispose(): void;
}

export interface StandaloneAgentCreationOptions {
  readonly sessionKey: string;
}
export interface StandaloneAgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: StandaloneAgentCreationOptions,
  ): Promise<StandaloneAgent>;
}
