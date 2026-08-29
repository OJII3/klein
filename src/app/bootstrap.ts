import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator.js";
import { TaskCoordinator } from "./task-coordinator.js";
import { DiscordAgent } from "../agents/discord/discord-agent.js";
import { createPiAgentFactory } from "../runtime/pi/pi-agent-runtime.js";
import { DiscordJsService } from "../modules/discord/infrastructure/discord-js-service.js";

export async function bootstrap(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const discordService = new DiscordJsService(token);
  const taskCoordinator = new TaskCoordinator();
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? ".runtime/pi");
  const piAgentFactory = createPiAgentFactory({ agentDir });
  const agentCoordinator = new AgentCoordinator({
    createDiscordAgent: (channelId) =>
      DiscordAgent.create(piAgentFactory, discordService, channelId),
    discordService,
    taskCoordinator,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    await discordService.stop();
    await taskCoordinator.waitForCompletion();
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
