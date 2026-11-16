import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type {
  AgentCreationOptions,
  AgentFactory,
  AgentToolsFactory,
} from "@agents/core/agent-factory";
import type { AgentDefinition } from "@agents/core/agent-definition";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import type { AgentTurn } from "@agents/core/agent-turn";
import type { PiTool } from "./pi-tool";
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
export function createPiMinimalAgentFactory(
  options: PiMinimalAgentFactoryOptions,
): AgentFactory<PiTool> {
  return {
    async create(
      definition: AgentDefinition,
      createTools: AgentToolsFactory<PiTool>,
      creation: AgentCreationOptions,
    ): Promise<AgentRuntime> {
      if (creation.role.kind !== "standalone") {
        throw new Error("The minimal agent factory only creates standalone agents");
      }
      if (creation.initialContext) {
        throw new Error("The minimal agent factory does not support initial context");
      }

      const turnState: { requesterId?: string } = {};
      const tools = createTools({
        requesterId: () => turnState.requesterId,
      });
      const session = await options.runner.createSession({
        cwd: options.cwd,
        model: options.model,
        sessionId: creation.sessionKey,
        systemPrompt: definition.systemPrompt,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        toolNames: definition.toolNames ?? tools.map((tool) => tool.name),
        tools,
      });
      return new PiMinimalAgentRuntime(session, turnState);
    },
  };
}

class PiMinimalAgentRuntime implements AgentRuntime {
  private lastText: string | undefined;

  constructor(
    private readonly session: PiSession,
    private readonly turnState: { requesterId?: string },
  ) {}

  async prompt(turn: AgentTurn): Promise<void> {
    this.lastText = undefined;
    const text = turn.event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    this.turnState.requesterId = turn.context.requesterId;
    try {
      this.lastText = await this.session.prompt(text);
    } finally {
      this.turnState.requesterId = undefined;
    }
  }

  lastAssistantText(): string | undefined {
    return this.lastText;
  }

  dispose(): void {
    this.session.dispose();
  }
}
