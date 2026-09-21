import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator";
import { parseCliOptions } from "./cli-options";
import { loadConfig } from "./config";
import { createLogFilePath, createLogger, flushLogger } from "./logger";
import { loadPromptFile } from "./prompt";
import { TaskCoordinator } from "./task-coordinator";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import { DiscordAgent } from "@agents/discord/discord-agent";
import {
  createPiAgentFactory,
  createPiModelRuntime,
  resolveConfiguredModel,
  withOpenCodeSessionHeader,
} from "@runtime/pi/pi-agent-runtime";
import { PiMemoryProcessor } from "@runtime/pi/pi-memory-processor";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import { DiscordJsService } from "@modules/discord/infrastructure/discord-js-service";
import { DiscordVoiceService } from "@modules/discord/infrastructure/discord-voice-service";
import { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import { OpenAiLiveVoiceSessionFactory } from "@modules/live/infrastructure/openai-live-voice-session";
import { createGetMonthlyUsageLimit } from "@modules/usage/application/get-monthly-usage-limit";
import { formatMonthlyUsageStatus } from "@modules/usage/application/format-monthly-usage-status";
import { OpenCodeGoUsageProvider } from "@modules/usage/infrastructure/opencode-go-usage-provider";
import { resolveLogDirectory, resolveWebUiConfig } from "@modules/webui/domain/webui-config";
import { startWebUi } from "@modules/webui/infrastructure/elysia-webui-app";
import { PinoJsonlReader } from "@modules/webui/infrastructure/pino-jsonl-reader";
import { PiSessionReader } from "@modules/webui/infrastructure/pi-session-reader";
import { createOpenCodeCodingHarness } from "@modules/coding/infrastructure/opencode-coding-harness";

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
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for Discord voice conversations");
  }

  const discordOperatingState = new DiscordOperatingState();
  const discordAccessPolicy = createDiscordAccessPolicy(config.discord.access);
  const discordService = new DiscordJsService(
    token,
    discordAccessPolicy,
    logger,
    discordOperatingState,
  );
  const taskCoordinator = new TaskCoordinator();
  const agentDir = resolve(config.runtime.agentDir);
  const modelRuntime = await createPiModelRuntime(agentDir);
  const piAgentFactory = createPiAgentFactory({
    agentDir,
    llm: config.llm,
    logger,
    modelRuntime,
    sessionMode,
  });
  const memoryConfiguration = config.features.memory;
  const memoryLlmConfiguration = memoryConfiguration.llm ?? config.llm;
  const memorySessionId = `memory-${randomUUID()}`;
  const memoryCoordinator = memoryConfiguration.enabled
    ? new MemoryCoordinator({
        filePath: memoryConfiguration.filePath ?? ".runtime/memory/{guildId}/MEMORY.md",
        idleSeconds: memoryConfiguration.idleSeconds ?? 180,
        logger,
        maxBatchAgeSeconds: memoryConfiguration.maxBatchAgeSeconds ?? 1800,
        maxBatchMessages: memoryConfiguration.maxBatchMessages ?? 32,
        processor: new PiMemoryProcessor(
          withOpenCodeSessionHeader(
            resolveConfiguredModel(
              memoryLlmConfiguration.provider,
              memoryLlmConfiguration.model,
              modelRuntime,
            ),
            memorySessionId,
          ),
          memoryLlmConfiguration.thinkingLevel,
        ),
        taskCoordinator,
      })
    : undefined;
  const codingConfiguration = config.features.coding;
  const codingHarness = codingConfiguration?.enabled
    ? createOpenCodeCodingHarness({
        serverUrl: codingConfiguration.serverUrl ?? "http://127.0.0.1:4096",
        projects: codingConfiguration.projects ?? {},
        username: process.env.OPENCODE_SERVER_USERNAME,
        password: process.env.OPENCODE_SERVER_PASSWORD,
      })
    : undefined;
  if (codingHarness) {
    await codingHarness.checkConnection();
    logger.info(
      {
        event: "coding_harness_connected",
        serverUrl: codingConfiguration?.serverUrl ?? "http://127.0.0.1:4096",
        projects: Object.keys(codingConfiguration?.projects ?? {}),
      },
      "Connected to OpenCode coding server",
    );
  }
  const liveVoiceSessionFactory = new OpenAiLiveVoiceSessionFactory(openAiApiKey, logger);
  const discordVoiceService = new DiscordVoiceService(
    discordService,
    discordAccessPolicy,
    liveVoiceSessionFactory,
    systemPrompt,
    (request) =>
      new Promise<string>((resolve, reject) => {
        void taskCoordinator.run(async () => {
          let runtime: AgentRuntime | undefined;
          try {
            runtime = await piAgentFactory.create(
              {
                systemPrompt:
                  `${systemPrompt}\n\n` +
                  "You are the backend reasoning model for a live Discord voice conversation. " +
                  "Answer the delegated request in plain text for the voice front end. " +
                  "Do not use Discord output tools and do not describe this internal delegation.",
                toolNames: [],
              },
              [],
              { sessionKey: `discord-voice:${request.guildId}` },
            );
            const guildMemory = await memoryCoordinator?.getContext(
              request.guildId,
              request.transcript,
            );
            const prompt = guildMemory
              ? `<guild-memory>\n${guildMemory}\n</guild-memory>\n\n${request.transcript}`
              : request.transcript;
            if (!runtime.promptForText) {
              throw new Error("Pi runtime does not support text responses");
            }
            resolve(await runtime.promptForText({ text: prompt, images: [] }));
          } catch (error) {
            reject(error);
          } finally {
            runtime?.dispose();
          }
        });
      }),
    logger,
  );
  discordService.setVoiceCommandHandler(discordVoiceService);
  const agentCoordinator = new AgentCoordinator({
    createDiscordAgent: (channelId) =>
      DiscordAgent.create(piAgentFactory, discordService, channelId, systemPrompt, codingHarness),
    discordService,
    logger,
    memoryCoordinator,
    operatingState: discordOperatingState,
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
        memory: memoryCoordinator,
        memoryEditor: memoryCoordinator,
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
    await discordVoiceService.stop();
    memoryCoordinator?.dispose();
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
