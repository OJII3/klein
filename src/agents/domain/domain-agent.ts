import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import type { AgentFactory } from "../core/agent-factory";
import type { AgentPrompt, AgentPromptResult, AgentRuntime } from "../core/agent-runtime";
import { formatDiscordMessage, type DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createDiscordReadTool } from "../discord/tools/discord-read";
import { createReminderTools } from "../discord/tools/reminder";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createAgentSendEventTool } from "../tools/agent-send-event";
import { createDomainAgentSystemPrompt, DOMAIN_AGENT_BASE_TOOL_NAMES } from "./prompt-policy";

const DISCORD_MAX_MESSAGE_LENGTH = 2_000;
const NO_ACTION_TOKEN = "NO_ACTION";

export interface DomainAgentCreateOptions {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly systemPrompt: string;
  readonly channelId?: string;
  readonly discordService?: DiscordService;
  readonly sessionKey?: string;
  readonly handoffContext?: string;
  readonly reminderStore?: ReminderStore;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly eventRouter?: AgentEventRouter;
}

export class DomainAgent {
  private constructor(
    readonly agentId: string,
    private readonly runtime: AgentRuntime,
    private readonly ownerUserId: string,
    private readonly channelId?: string,
    private readonly discordService?: DiscordService,
  ) {}

  static async create(
    agentFactory: AgentFactory,
    options: DomainAgentCreateOptions,
  ): Promise<DomainAgent> {
    let runtime: AgentRuntime | undefined;
    const analyzeImages = async (message: DiscordMessage): Promise<string | undefined> => {
      if (!runtime?.analyzeImage) return undefined;

      const prompt: AgentPrompt = {
        text: formatDiscordMessage(message),
        images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
      };
      return runtime.analyzeImage(prompt);
    };

    const discordTools =
      options.discordService && options.channelId
        ? [
            createDiscordReadTool(options.discordService, options.channelId, analyzeImages, {
              userId: options.ownerUserId,
            }),
          ]
        : [];
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

    const tools = [...discordTools, ...reminderTools, ...ownerMemoryTools, ...eventRouterTools];
    const toolNames: string[] = [
      ...DOMAIN_AGENT_BASE_TOOL_NAMES,
      ...tools.map((tool) => tool.name),
    ];

    const composedPrompt = createDomainAgentSystemPrompt(options.agentId, options.systemPrompt, {
      availableTargets: options.eventRouter?.listTargets(),
    });

    runtime = await agentFactory.create(
      {
        systemPrompt: composedPrompt,
        toolNames,
        outputMode: "assistant_text",
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
      },
    );

    return new DomainAgent(
      options.agentId,
      runtime,
      options.ownerUserId,
      options.channelId,
      options.discordService,
    );
  }

  prompt(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void> {
    const event = this.createMessageEvent(message, guildMemory, channelRule, ownerMemory);
    return this.runtime.prompt(event).then((result) => this.deliverAssistantText(result));
  }

  steer(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): Promise<void> {
    const event = this.createMessageEvent(message, guildMemory, channelRule, ownerMemory);
    const execution = this.runtime.steer ? this.runtime.steer(event) : this.runtime.prompt(event);
    return execution.then((result) => this.deliverAssistantText(result));
  }

  promptEvent(event: AgentEvent, ownerMemory?: string): Promise<void> {
    return this.runtime
      .prompt(this.withOwnerMemory(event, ownerMemory))
      .then((result) => this.deliverAssistantText(result));
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

  private createMessageEvent(
    message: DiscordMessage,
    guildMemory?: string,
    channelRule?: string,
    ownerMemory?: string,
  ): AgentEvent {
    if (
      message.author.bot ||
      message.author.id !== this.ownerUserId ||
      (this.channelId !== undefined && message.channelId !== this.channelId)
    ) {
      throw new Error("Only the owner can use this domain agent in its configured channel");
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
            ownerMemory ? `<owner-memory>\n${ownerMemory}\n</owner-memory>` : undefined,
            guildMemory ? `<guild-memory>\n${guildMemory}\n</guild-memory>` : undefined,
            channelRule ? `<channel-rule>\n${channelRule}\n</channel-rule>` : undefined,
            formatDiscordMessage(message),
          ]
            .filter((context): context is string => context !== undefined)
            .join("\n\n"),
        },
        ...message.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
      ],
    };
  }

  private withOwnerMemory(event: AgentEvent, ownerMemory?: string): AgentEvent {
    if (!ownerMemory) return event;
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

  private async deliverAssistantText(result: AgentPromptResult | void): Promise<void> {
    if (!this.discordService || !this.channelId) return;
    const text = result?.assistantText?.trim();
    if (!text || text === NO_ACTION_TOKEN) return;

    for (const chunk of splitDiscordMessage(text)) {
      await this.discordService.sendMessage(this.channelId, chunk);
    }
  }
}

export function splitDiscordMessage(
  text: string,
  maxLength = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
