import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator.js";
import { parseCliOptions } from "./cli-options.js";
import { loadConfig } from "./config.js";
import { createLogFilePath, createLogger, flushLogger } from "./logger.js";
import { loadPromptFile } from "./prompt.js";
import { TaskCoordinator } from "./task-coordinator.js";
import { DiscordAgent } from "../agents/discord/discord-agent.js";
import { createCodexTools } from "../agents/discord/tools/codex-delegate.js";
import { createPiAgentFactory } from "../runtime/pi/pi-agent-runtime.js";
import { createDiscordAccessPolicy } from "../modules/discord/domain/discord-access-policy.js";
import { DiscordJsService } from "../modules/discord/infrastructure/discord-js-service.js";
import { createGetMonthlyUsageLimit } from "../modules/usage/application/get-monthly-usage-limit.js";
import { formatMonthlyUsageStatus } from "../modules/usage/application/format-monthly-usage-status.js";
import { OpenCodeGoUsageProvider } from "../modules/usage/infrastructure/opencode-go-usage-provider.js";
import { resolveLogDirectory, resolveWebUiConfig } from "../modules/webui/domain/webui-config.js";
import { startWebUi } from "../modules/webui/infrastructure/elysia-webui-app.js";
import { PinoJsonlReader } from "../modules/webui/infrastructure/pino-jsonl-reader.js";
import { PiSessionReader } from "../modules/webui/infrastructure/pi-session-reader.js";

const DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

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
  const codexConfiguration = config.features.codexAppServer;
  const codexToolOptions = codexConfiguration?.enabled
    ? {
        defaultWorkspace: resolve(codexConfiguration.workspace),
        codexHome: codexConfiguration.codexHome ? resolve(codexConfiguration.codexHome) : undefined,
        logger,
        model: codexConfiguration.model,
        socketPath: resolve(codexConfiguration.socketPath),
        taskScheduler: taskCoordinator,
        timeoutMs: (codexConfiguration.timeoutSeconds ?? 900) * 1_000,
      }
    : undefined;
  const agentCoordinator = new AgentCoordinator({
    createDiscordAgent: (channelId) =>
      DiscordAgent.create(
        piAgentFactory,
        discordService,
        channelId,
        systemPrompt,
        codexToolOptions
          ? createCodexTools({
              ...codexToolOptions,
              channelId,
              discordService,
            })
          : undefined,
      ),
    discordService,
    logger,
    taskCoordinator,
  });
  const getMonthlyUsageLimit = createGetMonthlyUsageLimit(
    new OpenCodeGoUsageProvider(openCodeGoApiKey),
  );
  const updateDiscordUsageStatus = async (): Promise<void> => {
    try {
      const monthly = await getMonthlyUsageLimit();
      discordService.setActivity(formatMonthlyUsageStatus(monthly));
    } catch (error) {
      logger.warn(
        { err: error, event: "discord_usage_status_update_failed" },
        "Failed to update Discord usage status",
      );
    }
  };
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

  let usageStatusInterval: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown_started", signal }, "Shutting down");

    if (usageStatusInterval) {
      clearInterval(usageStatusInterval);
      usageStatusInterval = undefined;
    }
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

  await discordService.start((message) => agentCoordinator.handleDiscordMessage(message));
  await updateDiscordUsageStatus();
  usageStatusInterval = setInterval(() => {
    void updateDiscordUsageStatus();
  }, DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS);
}

try {
  await bootstrap();
} catch (error) {
  createLogger().fatal({ err: error, event: "bootstrap_failed" }, "Klein failed to start");
  process.exitCode = 1;
}
