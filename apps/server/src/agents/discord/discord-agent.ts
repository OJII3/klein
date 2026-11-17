import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentEvent } from "../core/agent-event";
import type { AgentFactory, AgentToolContext } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import type { AgentTurn, AgentTurnContext } from "../core/agent-turn";
import type { ConversationAgent } from "../core/conversation-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import {
  createDiscordMessageAgentTurn,
  type DiscordTurnContext,
} from "./discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "./prompt-policy";

export interface DiscordAgentCreateOptions {
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly ownerUserId?: string;
  readonly tools?: (context: AgentToolContext) => readonly ToolDefinition[];
}

export interface DiscordConversationAgent extends ConversationAgent {
  promptMessage(message: DiscordMessage, context?: DiscordTurnContext): Promise<void>;
  steerMessage?(message: DiscordMessage, context?: DiscordTurnContext): Promise<void>;
}

export class DiscordAgent implements DiscordConversationAgent {
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
    const ownerFeaturesAllowed = options.ownerFeaturesAllowed === true && !!options.ownerUserId;
    const runtime = await agentFactory.create(
      {
        systemPrompt,
      },
      options.tools ?? (() => []),
      {
        role: { kind: "conversation" },
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
    return this.runtime.prompt(turn).then(() => undefined);
  }

  promptEvent(event: AgentEvent, context: AgentTurnContext = {}): Promise<void> {
    return this.prompt({ event, context });
  }

  steer(turn: AgentTurn): Promise<void> {
    return (this.runtime.steer ? this.runtime.steer(turn) : this.runtime.prompt(turn)).then(
      () => undefined,
    );
  }

  promptMessage(message: DiscordMessage, context: DiscordTurnContext = {}): Promise<void> {
    return this.prompt(this.createMessageTurn(message, context));
  }

  steerMessage(message: DiscordMessage, context: DiscordTurnContext = {}): Promise<void> {
    return this.steer(this.createMessageTurn(message, context));
  }

  private createMessageTurn(message: DiscordMessage, context: DiscordTurnContext): AgentTurn {
    return createDiscordMessageAgentTurn(message, context, {
      botMessageGuidance: BOT_MESSAGE_GUIDANCE,
      ownerValidation:
        this.ownerFeaturesAllowed && this.ownerUserId
          ? { userId: this.ownerUserId, channelId: this.channelId }
          : undefined,
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
