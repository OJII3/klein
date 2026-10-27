import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import { formatAgentTurn, type AgentTurn, type AgentTurnContext } from "../core/agent-turn";
import type { ChannelAgent } from "../core/channel-agent";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import { createDiscordMessageAgentTurn } from "./discord-message-agent-turn";
import { BOT_MESSAGE_GUIDANCE } from "./prompt-policy";
import { createDiscordReadTool } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordVoiceTool } from "./tools/discord-voice";
import { createDiscordSpeakTool } from "./tools/discord-speak";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";
import { createReminderTools } from "./tools/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createAgentSendEventTool } from "../tools/agent-send-event";

export class DiscordAgent implements ChannelAgent {
  private constructor(
    private readonly runtime: AgentRuntime,
    private readonly channelId: string,
    private readonly ownerUserId?: string,
    private readonly ownerFeaturesAllowed = false,
  ) {}

  static async create(
    agentFactory: AgentFactory,
    discordService: DiscordService,
    channelId: string,
    systemPrompt: string,
    options: {
      readonly sessionKey?: string;
      readonly handoffContext?: string;
      readonly ownerFeaturesAllowed?: boolean;
      readonly ownerUserId?: string;
      readonly tts?: TextToSpeech;
      readonly speak?: (text: string, toolCallId?: string) => Promise<void>;
      readonly reminderStore?: ReminderStore;
      readonly ownerMemoryStore?: OwnerMemoryStore;
      readonly eventRouter?: AgentEventRouter;
    } = {},
  ): Promise<DiscordAgent> {
    let runtime: AgentRuntime | undefined;
    const analyzeImages = async (message: DiscordMessage): Promise<string | undefined> => {
      if (!runtime?.analyzeImage) return undefined;

      const prompt: AgentPrompt = {
        text: formatDiscordMessage(message),
        images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
      };
      return runtime.analyzeImage(prompt);
    };

    const ownerFeaturesAllowed = options.ownerFeaturesAllowed === true && !!options.ownerUserId;
    const ownerMemoryTools =
      ownerFeaturesAllowed && options.ownerMemoryStore
        ? createOwnerMemoryTools(options.ownerMemoryStore, `communication:${channelId}`)
        : [];
    const eventRouterTools =
      ownerFeaturesAllowed && options.eventRouter
        ? [createAgentSendEventTool(options.eventRouter, "communication")]
        : [];
    const tools = [
      createDiscordReadTool(
        discordService,
        channelId,
        analyzeImages,
        ownerFeaturesAllowed ? { userId: options.ownerUserId! } : undefined,
      ),
      ...(options.speak
        ? [createDiscordSpeakTool(options.speak)]
        : [createDiscordSendTool(discordService, channelId)]),
      ...(!options.speak && options.tts
        ? [createDiscordVoiceTool(discordService, channelId, options.tts)]
        : []),
      ...(options.reminderStore
        ? createReminderTools(
            options.reminderStore,
            channelId,
            ownerFeaturesAllowed ? `owner:${options.ownerUserId!}` : "public",
          )
        : []),
      ...ownerMemoryTools,
      ...eventRouterTools,
    ];
    runtime = await agentFactory.create(
      {
        systemPrompt,
      },
      tools,
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
