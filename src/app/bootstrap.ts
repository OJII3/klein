import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator.js";
import { loadConfig } from "./config.js";
import { loadPromptFile } from "./prompt.js";
import { TaskCoordinator } from "./task-coordinator.js";
import { DiscordAgent } from "../agents/discord/discord-agent.js";
import { createPiAgentFactory } from "../runtime/pi/pi-agent-runtime.js";
import { createDiscordAccessPolicy } from "../modules/discord/domain/discord-access-policy.js";
import { DiscordJsService } from "../modules/discord/infrastructure/discord-js-service.js";

export async function bootstrap(): Promise<void> {
  const config = await loadConfig();
  const systemPrompt = await loadPromptFile(config.agents?.discord?.systemPromptFile);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const discordService = new DiscordJsService(
    token,
    createDiscordAccessPolicy(config.discord.access),
  );
  const taskCoordinator = new TaskCoordinator();
  const agentDir = resolve(config.runtime.agentDir);
  const piAgentFactory = createPiAgentFactory({ agentDir, llm: config.llm });
  const agentCoordinator = new AgentCoordinator({
    createDiscordAgent: (channelId) =>
      DiscordAgent.create(piAgentFactory, discordService, channelId, systemPrompt),
    discordService,
    taskCoordinator,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    discordService.stopAccepting();
    await taskCoordinator.waitForCompletion();
    await discordService.stop();
    await agentCoordinator.dispose();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await discordService.start((message) => agentCoordinator.handleDiscordMessage(message));
}

await bootstrap();
