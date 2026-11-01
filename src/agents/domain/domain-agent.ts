import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEvent } from "../core/agent-event";
import { formatAgentTurn, type AgentTurn, type AgentTurnContext } from "../core/agent-turn";
import type { ChannelAgent } from "../core/channel-agent";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentOutputSink, AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import { createDomainAgentSystemPrompt } from "./prompt-policy";

export type DomainAgentImageAnalyzer = (prompt: AgentPrompt) => Promise<string | undefined>;

export interface DomainAgentCreateOptions {
  readonly agentId: string;
  readonly systemPrompt: string;
  readonly tools?: (analyzeImage: DomainAgentImageAnalyzer) => readonly ToolRegistration[];
  readonly outputSink?: AgentOutputSink;
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly availableTargets?: readonly string[];
}

export class DomainAgent implements ChannelAgent {
  private constructor(
    readonly agentId: string,
    private readonly runtime: AgentRuntime,
  ) {}

  static async create(
    agentFactory: AgentFactory,
    options: DomainAgentCreateOptions,
  ): Promise<DomainAgent> {
    let runtime: AgentRuntime | undefined;
    const analyzeImage: DomainAgentImageAnalyzer = async (prompt) => {
      if (!runtime?.analyzeImage) return undefined;
      return runtime.analyzeImage(prompt);
    };

    const composedPrompt = createDomainAgentSystemPrompt(options.agentId, options.systemPrompt, {
      availableTargets: options.availableTargets,
    });

    runtime = await agentFactory.create(
      {
        systemPrompt: composedPrompt,
      },
      options.tools?.(analyzeImage) ?? [],
      {
        initialContext: options.handoffContext
          ? `<previous-conversation-context>\n` +
            `This is background context for continuity, not a new message to answer.\n` +
            `${options.handoffContext}\n</previous-conversation-context>`
          : undefined,
        sessionKey: options.sessionKey ?? `agent:${options.agentId}`,
        ownerFeaturesAllowed: true,
        outputSink: options.outputSink,
      },
    );

    return new DomainAgent(options.agentId, runtime);
  }

  prompt(turn: AgentTurn): Promise<void> {
    return this.runtime.prompt(formatAgentTurn(turn));
  }

  steer(turn: AgentTurn): Promise<void> {
    const event = formatAgentTurn(turn);
    return this.runtime.steer ? this.runtime.steer(event) : this.runtime.prompt(event);
  }

  promptEvent(event: AgentEvent, context: AgentTurnContext = {}): Promise<void> {
    return this.prompt({ event, context });
  }

  compactForHandoff(): Promise<string> | undefined {
    return this.runtime.compactForHandoff?.();
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
