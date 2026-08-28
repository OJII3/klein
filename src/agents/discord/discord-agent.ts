import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { createDiscordSendTool } from "./tools/discord-send.js";
import type {
  DiscordChannel,
  DiscordService,
} from "../../modules/discord/ports/discord-service.js";

const SYSTEM_PROMPT = `You are Klein, a conversational agent living in Discord.

Your normal assistant text is not shown to the user. The only user-visible output is sent through the discord_send tool.

Use discord_send for every message the user should see. You can send a message and then continue working, and you can send multiple messages during one turn. If silence is appropriate, do not call discord_send.

Keep messages natural and concise for a chat conversation.`;

export class DiscordAgent {
  private readonly session: AgentSession;
  private queue: Promise<void> = Promise.resolve();

  private constructor(session: AgentSession) {
    this.session = session;
  }

  static async create(
    discordService: DiscordService,
    channel: DiscordChannel,
  ): Promise<DiscordAgent> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: SYSTEM_PROMPT,
    });

    await resourceLoader.reload();

    const { session } = await createAgentSession({
      customTools: [createDiscordSendTool(discordService, channel)],
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      tools: ["discord_send"],
    });

    return new DiscordAgent(session);
  }

  prompt(author: string, content: string): Promise<void> {
    const run = this.queue.then(() =>
      this.session.prompt(`${author}:\n${content}`, { source: "rpc" }),
    );

    this.queue = run.catch((error: unknown) => {
      console.error("Discord agent prompt failed:", error);
    });

    return run;
  }

  dispose(): void {
    this.session.dispose();
  }
}
