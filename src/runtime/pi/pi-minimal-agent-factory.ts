import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "@agents/core/agent-definition";
import type {
  StandaloneAgent,
  StandaloneAgentCreationOptions,
  StandaloneAgentFactory,
} from "@agents/core/standalone-agent";
import type { PiTool } from "./pi-tool";
import type { PiStandaloneSessionRunner } from "./pi-standalone-session-runner";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface PiMinimalAgentFactoryOptions {
  readonly runner: PiStandaloneSessionRunner;
  readonly model: Model<Api>;
  readonly cwd: string;
  readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Creates standalone agents on the minimal Pi session profile. Implements
 * {@link StandaloneAgentFactory} so standalone agents receive plain prompts
 * directly without wrapping them in event metadata or turn contexts.
 */
export function createPiMinimalAgentFactory(
  options: PiMinimalAgentFactoryOptions,
): StandaloneAgentFactory<PiTool> {
  return {
    async create(
      definition: AgentDefinition,
      tools: readonly PiTool[],
      creation: StandaloneAgentCreationOptions,
    ): Promise<StandaloneAgent> {
      return options.runner.createSession({
        cwd: options.cwd,
        model: options.model,
        sessionId: creation.sessionKey,
        systemPrompt: definition.systemPrompt,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        toolNames: definition.toolNames ?? tools.map((tool) => tool.name),
        tools,
      });
    },
  };
}
