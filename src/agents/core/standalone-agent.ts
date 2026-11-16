import type { AgentDefinition } from "./agent-definition";
import type { AgentTool } from "./agent-tool";

export interface StandaloneAgentPromptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * An agent that belongs to no conversation. The caller drives it with a
 * prompt string and receives its assistant text directly.
 */
export interface StandaloneAgent {
  prompt(text: string, options?: StandaloneAgentPromptOptions): Promise<string | undefined>;
  dispose(): void;
}

export interface StandaloneAgentCreationOptions {
  readonly sessionKey: string;
}

/**
 * Creates a standalone agent without wrapping its input in an event or turn
 * context. Standalone agents never hold surface tools.
 */
export interface StandaloneAgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: StandaloneAgentCreationOptions,
  ): Promise<StandaloneAgent>;
}
