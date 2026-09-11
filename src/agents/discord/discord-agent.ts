import type { AgentFactory } from "../core/agent-factory.js";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime.js";
import {
  formatDiscordMessage,
  type DiscordMessage,
} from "../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../modules/discord/ports/discord-service.js";
import { DISCORD_AGENT_TOOL_NAMES } from "./prompt-policy.js";
import { createDiscordReadTool } from "./tools/discord-read.js";
import { createDiscordSendTool } from "./tools/discord-send.js";

export class DiscordAgent {
  private constructor(private readonly runtime: AgentRuntime) {}

  static async create(
    agentFactory: AgentFactory,
    discordService: DiscordService,
    channelId: string,
    systemPrompt: string,
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

    runtime = await agentFactory.create(
      {
        systemPrompt,
        toolNames: DISCORD_AGENT_TOOL_NAMES,
      },
      [
        createDiscordReadTool(discordService, channelId, analyzeImages),
        createDiscordSendTool(discordService, channelId),
      ],
      { sessionKey: `discord-channel:${channelId}` },
    );

    return new DiscordAgent(runtime);
  }

  prompt(message: DiscordMessage): Promise<void> {
    return this.runtime.prompt({
      text: formatDiscordMessage(message),
      images: message.images.map(({ data, mimeType }) => ({ data, mimeType })),
    });
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
