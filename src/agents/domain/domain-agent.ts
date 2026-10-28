import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import { formatAgentTurn, type AgentTurn, type AgentTurnContext } from "../core/agent-turn";
import type { ChannelAgent } from "../core/channel-agent";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentOutputSink, AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createReminderTools } from "../discord/tools/reminder";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createAgentSendEventTool } from "../tools/agent-send-event";
import { createDomainAgentSystemPrompt } from "./prompt-policy";

export type DomainAgentImageAnalyzer = (prompt: AgentPrompt) => Promise<string | undefined>;

export interface DomainAgentCreateOptions {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly systemPrompt: string;
  readonly channelId?: string;
  readonly channelTools?: (analyzeImage: DomainAgentImageAnalyzer) => readonly ToolRegistration[];
  readonly outputSink?: AgentOutputSink;
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly reminderStore?: ReminderStore;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly eventRouter?: AgentEventRouter;
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

    const channelTools = options.channelTools?.(analyzeImage) ?? [];
    const reminderTools =
      options.reminderStore && options.channelId
        ? createReminderTools(
            options.reminderStore,
            options.channelId,
            `owner:${options.ownerUserId}`,
          )
        : [];
    const ownerMemoryTools = options.ownerMemoryStore
      ? createOwnerMemoryTools(options.ownerMemoryStore, `agent:${options.agentId}`)
      : [];
    const eventRouterTools = options.eventRouter
      ? [createAgentSendEventTool(options.eventRouter, options.agentId)]
      : [];

    const tools = [...channelTools, ...reminderTools, ...ownerMemoryTools, ...eventRouterTools];
    const composedPrompt = createDomainAgentSystemPrompt(options.agentId, options.systemPrompt, {
      availableTargets: options.eventRouter?.listTargets(),
    });

    runtime = await agentFactory.create(
      {
        systemPrompt: composedPrompt,
      },
      tools,
      {
        initialContext: options.handoffContext
          ? `<previous-conversation-context>\n` +
            `This is background context for continuity, not a new message to answer.\n` +
            `${options.handoffContext}\n</previous-conversation-context>`
          : undefined,
        sessionKey: options.sessionKey ?? `domain-agent:${options.agentId}`,
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
