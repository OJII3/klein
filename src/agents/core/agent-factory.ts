import type { AgentDefinition } from "./agent-definition";
import type { AgentRuntime } from "./agent-runtime";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export interface AgentCreationOptions {
  readonly sessionKey: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly initialContext?: string;
}

export interface AgentFactory {
  create(
    definition: AgentDefinition,
    tools: readonly ToolRegistration[],
    options: AgentCreationOptions,
  ): Promise<AgentRuntime>;
}
