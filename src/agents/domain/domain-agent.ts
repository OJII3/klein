import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import { formatAgentTurn, type AgentTurn, type AgentTurnContext } from "../core/agent-turn";
import type { ChannelAgent } from "../core/channel-agent";
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
import { createDomainAgentSystemPrompt } from "./prompt-policy";

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

export class DomainAgent implements ChannelAgent {
  private constructor(
    readonly agentId: string,
    private readonly runtime: AgentRuntime,
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
    const composedPrompt = createDomainAgentSystemPrompt(options.agentId, options.systemPrompt, {
      availableTargets: options.eventRouter?.listTargets(),
    });

    runtime = await agentFactory.create(
      {
        systemPrompt: composedPrompt,
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

    return new DomainAgent(options.agentId, runtime, options.channelId, options.discordService);
  }

  prompt(turn: AgentTurn): Promise<void> {
    const event = formatAgentTurn(turn);
    return this.runtime.prompt(event).then((result) => this.deliverAssistantText(result));
  }

  steer(turn: AgentTurn): Promise<void> {
    const event = formatAgentTurn(turn);
    const execution = this.runtime.steer ? this.runtime.steer(event) : this.runtime.prompt(event);
    return execution.then((result) => this.deliverAssistantText(result));
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
