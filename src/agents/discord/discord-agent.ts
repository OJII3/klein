import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEvent } from "../core/agent-event";
import { formatAgentTurn, type AgentTurn, type AgentTurnContext } from "../core/agent-turn";
import type { ChannelAgent } from "../core/channel-agent";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import { createDiscordMessageAgentTurn } from "./discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "./prompt-policy";
import type { DiscordImageAnalysis } from "./tools/discord-read";

export interface DiscordAgentCreateOptions {
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly ownerUserId?: string;
  readonly tools?: (analyzeImage: DiscordImageAnalysis) => readonly ToolRegistration[];
}

export class DiscordAgent implements ChannelAgent {
  private constructor(
    private readonly runtime: AgentRuntime,
    private readonly channelId: string,
    private readonly ownerUserId?: string,
    private readonly ownerFeaturesAllowed = false,
  ) {}

  static async create(
    agentFactory: AgentFactory,
    channelId: string,
    systemPrompt: string,
    options: DiscordAgentCreateOptions = {},
  ): Promise<DiscordAgent> {
    let runtime: AgentRuntime | undefined;
    const analyzeImage: DiscordImageAnalysis = async (message) => {
      if (!runtime?.analyzeImage) return undefined;

      return runtime.analyzeImage({
        text: formatDiscordMessage(message),
        images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
      });
    };

    const ownerFeaturesAllowed = options.ownerFeaturesAllowed === true && !!options.ownerUserId;
    runtime = await agentFactory.create(
      {
        systemPrompt,
      },
      options.tools?.(analyzeImage) ?? [],
      {
        initialContext: options.handoffContext
          ? `<previous-conversation-context>\n` +
            `This is background context for continuity, not a new message to answer.\n` +
            `${options.handoffContext}\n</previous-conversation-context>`
          : undefined,
        sessionKey: options.sessionKey ?? `discord-channel:${channelId}`,
        ownerFeaturesAllowed,
      },
    );

    return new DiscordAgent(runtime, channelId, options.ownerUserId, ownerFeaturesAllowed);
  }

  prompt(turn: AgentTurn): Promise<void> {
    return this.runtime.prompt(this.formatTurn(turn)).then(() => undefined);
  }

  promptEvent(event: AgentEvent, context: AgentTurnContext = {}): Promise<void> {
    return this.prompt({ event, context });
  }

  steer(turn: AgentTurn): Promise<void> {
    const event = this.formatTurn(turn);
    return (this.runtime.steer ? this.runtime.steer(event) : this.runtime.prompt(event)).then(
      () => undefined,
    );
  }

  promptMessage(message: DiscordMessage, context: AgentTurnContext = {}): Promise<void> {
    return this.prompt(this.createMessageTurn(message, context));
  }

  steerMessage(message: DiscordMessage, context: AgentTurnContext = {}): Promise<void> {
    return this.steer(this.createMessageTurn(message, context));
  }

  private createMessageTurn(message: DiscordMessage, context: AgentTurnContext): AgentTurn {
    return createDiscordMessageAgentTurn(message, context, {
      botMessageGuidance: BOT_MESSAGE_GUIDANCE,
      ownerValidation:
        this.ownerFeaturesAllowed && this.ownerUserId
          ? { userId: this.ownerUserId, channelId: this.channelId }
          : undefined,
    });
  }

  private formatTurn(turn: AgentTurn): AgentEvent {
    return formatAgentTurn({
      ...turn,
      context: {
        ...turn.context,
        ownerMemory: this.ownerFeaturesAllowed ? turn.context.ownerMemory : undefined,
      },
    });
  }

  compactForHandoff(): Promise<string> | undefined {
    return this.runtime.compactForHandoff?.();
  }

  abort(): Promise<void> {
    return this.runtime.abort?.() ?? Promise.resolve();
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
