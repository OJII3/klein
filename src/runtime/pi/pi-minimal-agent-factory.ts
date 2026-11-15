import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentCreationOptions, AgentFactory } from "@agents/core/agent-factory";
import type { AgentDefinition } from "@agents/core/agent-definition";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import type { AgentTurn } from "@agents/core/agent-turn";
import type { PiSession, PiStandaloneSessionRunner } from "./pi-standalone-session-runner";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface PiMinimalAgentFactoryOptions {
  readonly runner: PiStandaloneSessionRunner;
  readonly model: Model<Api>;
  readonly cwd: string;
  readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Creates standalone agents on the minimal Pi session profile. The factory
 * implements the core AgentFactory interface, so standalone agents use the
 * same AgentRuntime contract as conversation and attached agents while keeping
 * the minimal session configuration.
 */
export function createPiMinimalAgentFactory(options: PiMinimalAgentFactoryOptions): AgentFactory {
  return {
    async create<TTool = ToolDefinition>(
      definition: AgentDefinition,
      tools: readonly TTool[],
      creation: AgentCreationOptions,
    ): Promise<AgentRuntime> {
      if (creation.role.kind !== "standalone") {
        throw new Error("The minimal agent factory only creates standalone agents");
      }
      if (creation.initialContext) {
        throw new Error("The minimal agent factory does not support initial context");
      }

      const toolDefinitions = tools as readonly ToolDefinition[];
      const session = await options.runner.createSession({
        cwd: options.cwd,
        model: options.model,
        sessionId: creation.sessionKey,
        systemPrompt: definition.systemPrompt,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        toolNames: definition.toolNames ?? toolDefinitions.map((tool) => tool.name),
        tools: toolDefinitions,
      });
      return new PiMinimalAgentRuntime(session);
    },
  };
}

class PiMinimalAgentRuntime implements AgentRuntime {
  private lastText: string | undefined;

  constructor(private readonly session: PiSession) {}

  async prompt(turn: AgentTurn): Promise<void> {
    this.lastText = undefined;
    const text = turn.event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    this.lastText = await this.session.prompt(text);
  }

  lastAssistantText(): string | undefined {
    return this.lastText;
  }

  dispose(): void {
    this.session.dispose();
  }
}
