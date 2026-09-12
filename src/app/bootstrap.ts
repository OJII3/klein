import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator.js";
import { parseCliOptions } from "./cli-options.js";
import { loadConfig } from "./config.js";
import { createLogFilePath, createLogger, flushLogger } from "./logger.js";
import { loadPromptFile } from "./prompt.js";
import { TaskCoordinator } from "./task-coordinator.js";
import { DiscordAgent } from "../agents/discord/discord-agent.js";
import { createPiAgentFactory } from "../runtime/pi/pi-agent-runtime.js";
import { createDiscordSlashCommandRouter } from "../modules/discord/application/commands/discord-slash-command-router.js";
import { createOpenCodeGoLimitCommand } from "../modules/discord/application/commands/opencode-go-limit-command.js";
import { createDiscordAccessPolicy } from "../modules/discord/domain/discord-access-policy.js";
import { DiscordJsService } from "../modules/discord/infrastructure/discord-js-service.js";
import { createGetMonthlyUsageLimit } from "../modules/usage/application/get-monthly-usage-limit.js";
import { OpenCodeGoUsageProvider } from "../modules/usage/infrastructure/opencode-go-usage-provider.js";
import { resolveLogDirectory, resolveWebUiConfig } from "../modules/webui/domain/webui-config.js";
import { startWebUi } from "../modules/webui/infrastructure/elysia-webui-app.js";
import { PinoJsonlReader } from "../modules/webui/infrastructure/pino-jsonl-reader.js";
import { PiSessionReader } from "../modules/webui/infrastructure/pi-session-reader.js";

export async function bootstrap(): Promise<void> {
  const { sessionMode } = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig();
  const logDirectory = resolveLogDirectory(config);
  const logger = createLogger({ filePath: createLogFilePath(logDirectory) });
  logger.info({ event: "application_starting" }, "Starting Klein");

  const systemPrompt = await loadPromptFile(config.agents?.discord?.systemPromptFile);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }
  const openCodeGoApiKey = process.env.OPENCODE_API_KEY;
  if (!openCodeGoApiKey) {
    throw new Error("OPENCODE_API_KEY is required");
  }

  const discordService = new DiscordJsService(
    token,
    createDiscordAccessPolicy(config.discord.access),
    logger,
  );
  const taskCoordinator = new TaskCoordinator();
  const agentDir = resolve(config.runtime.agentDir);
  const piAgentFactory = createPiAgentFactory({
    agentDir,
    llm: config.llm,
    logger,
    sessionMode,
  });
  const agentCoordinator = new AgentCoordinator({
    createDiscordAgent: (channelId) =>
      DiscordAgent.create(piAgentFactory, discordService, channelId, systemPrompt),
    discordService,
    logger,
    taskCoordinator,
  });
  const getMonthlyUsageLimit = createGetMonthlyUsageLimit(
    new OpenCodeGoUsageProvider(openCodeGoApiKey),
  );
  const discordSlashCommandHandler = createDiscordSlashCommandRouter([
    createOpenCodeGoLimitCommand(getMonthlyUsageLimit),
  ]);
  const webUiConfig = resolveWebUiConfig(config);
  const webUi = webUiConfig.enabled
    ? await startWebUi({
        host: webUiConfig.host,
        logger,
        piSessions: new PiSessionReader(agentDir),
        pinoLogs: new PinoJsonlReader(logDirectory),
        port: webUiConfig.port,
        staticDirectory: resolve("dist/web"),
      })
    : undefined;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown_started", signal }, "Shutting down");

    await webUi?.stop();
    discordService.stopAccepting();
    await taskCoordinator.waitForCompletion();
    await discordService.stop();
    await agentCoordinator.dispose();
    logger.info({ event: "shutdown_completed" }, "Shutdown complete");
    flushLogger(logger);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await discordService.start(
    (message) => agentCoordinator.handleDiscordMessage(message),
    discordSlashCommandHandler,
  );
}

try {
  await bootstrap();
} catch (error) {
  createLogger().fatal({ err: error, event: "bootstrap_failed" }, "Klein failed to start");
  process.exitCode = 1;
}
