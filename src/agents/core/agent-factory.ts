import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agent-definition";
import type { AgentRole } from "./agent-role";
import type { AgentRuntime } from "./agent-runtime";

export interface AgentCreationOptions {
  readonly role: AgentRole;
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly initialContext?: string;
  /** Continue the most recent session in the session directory instead of starting a new one. */
  readonly resumeSession?: boolean;
}

export interface AgentFactory {
  create<TTool = ToolDefinition>(
    definition: AgentDefinition,
    tools: readonly TTool[],
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
