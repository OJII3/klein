import type { AgentFactory } from "../core/agent-factory.js";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime.js";
import {
  formatDiscordMessage,
  type DiscordMessage,
} from "../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../modules/discord/ports/discord-service.js";
import { DISCORD_AGENT_TOOL_NAMES } from "./prompt-policy.js";
import type { CodexTools } from "./tools/codex-delegate.js";
import { createDiscordReadTool } from "./tools/discord-read.js";
import { createDiscordSendTool } from "./tools/discord-send.js";

const BOT_MESSAGE_GUIDANCE = `

The latest Discord message was sent by another bot. Do not respond merely because it is addressed to you. Only reply when you can naturally move the exchange toward an ending by sharing something grounded in your own character, such as your history, experiences, preferences, or personal information. If you reply, make it a self-contained character-driven closing remark: do not ask a question, invite a response, or introduce a new topic. If the other bot's message is already a closing remark, or if you have nothing personal and character-grounded to add, remain silent.`;

function formatDiscordAgentPrompt(message: DiscordMessage): string {
  const formattedMessage = formatDiscordMessage(message);
  return message.author.bot ? `${formattedMessage}${BOT_MESSAGE_GUIDANCE}` : formattedMessage;
}

export class DiscordAgent {
  private constructor(private readonly runtime: AgentRuntime) {}

  static async create(
    agentFactory: AgentFactory,
    discordService: DiscordService,
    channelId: string,
    systemPrompt: string,
    codexTools?: CodexTools,
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

    const toolNames = codexTools
      ? [...DISCORD_AGENT_TOOL_NAMES, ...codexTools.map((tool) => tool.name)]
      : DISCORD_AGENT_TOOL_NAMES;
    const tools = codexTools
      ? [
          createDiscordReadTool(discordService, channelId, analyzeImages),
          createDiscordSendTool(discordService, channelId),
          ...codexTools,
        ]
      : [
          createDiscordReadTool(discordService, channelId, analyzeImages),
          createDiscordSendTool(discordService, channelId),
        ];

    runtime = await agentFactory.create(
      {
        systemPrompt,
        toolNames,
      },
      tools,
      { sessionKey: `discord-channel:${channelId}` },
    );

    return new DiscordAgent(runtime);
  }

  prompt(message: DiscordMessage): Promise<void> {
    return this.runtime.prompt({
      text: formatDiscordAgentPrompt(message),
      images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
    });
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
