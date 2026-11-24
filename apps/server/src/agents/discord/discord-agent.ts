import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentEvent } from "../core/agent-event";
import type { AgentFactory, AgentToolContext } from "../core/agent-factory";
import type { AgentRuntime, AgentTurnProgress } from "../core/agent-runtime";
import type { AgentTurn, AgentTurnContext } from "../core/agent-turn";
import type { ConversationAgent } from "../core/conversation-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import {
  createDiscordMessageAgentTurn,
  type DiscordTurnContext,
} from "./discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "./prompt-policy";
import type { AccessScope } from "@shared/access";

export interface DiscordAgentToolHooks {
  /** Called after a tool has sent a user-visible message to the channel. */
  readonly onMessageSent: () => void;
}

export interface DiscordAgentCreateOptions {
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly ownerUserId?: string;
  readonly accessScope?: AccessScope;
  readonly tools?: (
    context: AgentToolContext,
    hooks: DiscordAgentToolHooks,
  ) => readonly ToolDefinition[];
}

export interface DiscordConversationAgent extends ConversationAgent {
  promptMessage(message: DiscordMessage, context?: DiscordTurnContext): Promise<void>;
  steerMessage?(message: DiscordMessage, context?: DiscordTurnContext): Promise<void>;
  /** Number of user-visible messages sent by this agent so far. */
  getSentMessageCount?(): number;
  /** Durable progress of the turn for an event id, read from the Pi session. */
  getTurnProgress(eventId: string): AgentTurnProgress;
}

export class DiscordAgent implements DiscordConversationAgent {
  private constructor(
    private readonly runtime: AgentRuntime,
    private readonly channelId: string,
    private readonly sentMessages: { count: number },
    private readonly ownerUserId: string | undefined,
    private readonly ownerFeaturesAllowed: boolean,
  ) {}

  static async create(
    agentFactory: AgentFactory,
    channelId: string,
    systemPrompt: string,
    options: DiscordAgentCreateOptions = {},
  ): Promise<DiscordAgent> {
    const ownerFeaturesAllowed = options.ownerFeaturesAllowed === true && !!options.ownerUserId;
    const sentMessages = { count: 0 };
    const runtime = await agentFactory.create(
      {
        systemPrompt,
      },
      (toolContext) =>
        options.tools?.(toolContext, {
          onMessageSent: () => {
            sentMessages.count += 1;
          },
        }) ?? [],
      {
        role: { kind: "conversation" },
        initialContext: options.handoffContext
          ? `<previous-conversation-context>\n` +
            `This is background context for continuity, not a new message to answer.\n` +
            `${options.handoffContext}\n</previous-conversation-context>`
          : undefined,
        sessionKey: options.sessionKey ?? `discord-channel:${channelId}`,
        ownerFeaturesAllowed,
        ...(options.accessScope ? { accessScope: options.accessScope } : {}),
      },
    );

    return new DiscordAgent(
      runtime,
      channelId,
      sentMessages,
      options.ownerUserId,
      ownerFeaturesAllowed,
    );
  }

  getSentMessageCount(): number {
    return this.sentMessages.count;
  }

  getTurnProgress(eventId: string): AgentTurnProgress {
    return this.runtime.getTurnProgress?.(eventId) ?? "none";
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
