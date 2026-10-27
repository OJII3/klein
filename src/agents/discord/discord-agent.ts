import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import type { ChannelAgent } from "../core/channel-agent";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import { createDiscordReadTool } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordVoiceTool } from "./tools/discord-voice";
import { createDiscordSpeakTool } from "./tools/discord-speak";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";
import { createReminderTools } from "./tools/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createAgentSendEventTool } from "../tools/agent-send-event";

const BOT_MESSAGE_GUIDANCE = `

The latest Discord message was sent by another bot. Do not respond merely because it is addressed to you. Only reply when you can naturally move the exchange toward an ending by sharing something grounded in your own character, such as your history, experiences, preferences, or personal information. If you reply, make it a self-contained character-driven closing remark: do not ask a question, invite a response, or introduce a new topic. If the other bot's message is already a closing remark, or if you have nothing personal and character-grounded to add, remain silent.`;

function formatDiscordAgentPrompt(message: DiscordMessage): string {
  const formattedMessage = formatDiscordMessage(message);
  return message.author.bot ? `${formattedMessage}${BOT_MESSAGE_GUIDANCE}` : formattedMessage;
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

  prompt(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void> {
    const event = this.createEvent(message, guildMemory, channelRule, ownerMemory);
    return this.runtime.prompt(event).then(() => undefined);
  }

  promptEvent(event: AgentEvent, ownerMemory?: string): Promise<void> {
    return this.runtime.prompt(this.withOwnerMemory(event, ownerMemory)).then(() => undefined);
  }

  steer(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void> {
    const event = this.createEvent(message, guildMemory, channelRule, ownerMemory);
    return (this.runtime.steer ? this.runtime.steer(event) : this.runtime.prompt(event)).then(
      () => undefined,
    );
  }

  private createEvent(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): AgentEvent {
    if (
      this.ownerFeaturesAllowed &&
      (message.author.bot ||
        message.author.id !== this.ownerUserId ||
        message.channelId !== this.channelId)
    ) {
      throw new Error("Only the owner can use this Discord agent in its configured channel");
    }

    return {
      id: message.id,
      occurredAt: message.occurredAt,
      type: "discord.message",
      source: "discord",
      content: [
        {
          type: "text",
          text: [
            this.ownerFeaturesAllowed && ownerMemory
              ? `<owner-memory>\n${ownerMemory}\n</owner-memory>`
              : undefined,
            guildMemory ? `<guild-memory>\n${guildMemory}\n</guild-memory>` : undefined,
            channelRule ? `<channel-rule>\n${channelRule}\n</channel-rule>` : undefined,
            formatDiscordAgentPrompt(message),
          ]
            .filter((context): context is string => context !== undefined)
            .join("\n\n"),
        },
        ...message.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
      ],
    };
  }

  private withOwnerMemory(event: AgentEvent, ownerMemory?: string): AgentEvent {
    if (!this.ownerFeaturesAllowed || !ownerMemory) return event;
    const textIndex = event.content.findIndex((block) => block.type === "text");
    if (textIndex === -1) {
      return {
        ...event,
        content: [
          { type: "text", text: `<owner-memory>\n${ownerMemory}\n</owner-memory>` },
          ...event.content,
        ],
      };
    }
    return {
      ...event,
      content: event.content.map((block, index) =>
        index === textIndex && block.type === "text"
          ? {
              type: "text",
              text: `<owner-memory>\n${ownerMemory}\n</owner-memory>\n\n${block.text}`,
            }
          : block,
      ),
    };
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
