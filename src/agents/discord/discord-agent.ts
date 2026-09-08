import type { AgentFactory } from "../core/agent-factory.js";
import type { AgentRuntime } from "../core/agent-runtime.js";
import {
  formatDiscordReply,
  formatDiscordUser,
  type DiscordReplyReference,
  type DiscordUser,
} from "../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../modules/discord/ports/discord-service.js";
import { DISCORD_AGENT_TOOL_NAMES } from "./prompt-policy.js";
import { createDiscordSendTool } from "./tools/discord-send.js";

export class DiscordAgent {
  private constructor(private readonly runtime: AgentRuntime) {}

  static async create(
    agentFactory: AgentFactory,
    discordService: DiscordService,
    channelId: string,
    systemPrompt: string,
  ): Promise<DiscordAgent> {
    const runtime = await agentFactory.create(
      {
        systemPrompt,
        toolNames: DISCORD_AGENT_TOOL_NAMES,
      },
      [createDiscordSendTool(discordService, channelId)],
    );

    return new DiscordAgent(runtime);
  }

  prompt(author: DiscordUser, content: string, replyTo?: DiscordReplyReference): Promise<void> {
    const replyContext = replyTo ? `${formatDiscordReply(replyTo)}\n` : "";
    return this.runtime.prompt(`${replyContext}${formatDiscordUser(author)}:\n${content}`);
  }

  dispose(): void {
    this.runtime.dispose();
  }
}
