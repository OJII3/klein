import type { AgentDefinition } from "./agent-definition";
import type { AgentRole } from "./agent-role";
import type { AgentRuntime } from "./agent-runtime";
import type { AgentTool } from "./agent-tool";

export interface AgentCreationOptions {
  readonly role: AgentRole;
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly initialContext?: string;
  /** Continue the most recent session in the session directory instead of starting a new one. */
  readonly resumeSession?: boolean;
}

/**
 * Creates an agent runtime. The tool type stays generic so the runtime adapter
 * receives its own tool shape, while the core layer sees only {@link AgentTool}.
 */
export interface AgentFactory<TTool extends AgentTool = AgentTool> {
  create(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
