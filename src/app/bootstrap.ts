import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator";
import { ChannelSessionStateStore } from "./channel-session-state-store";
import { parseCliOptions } from "./cli-options";
import { loadConfig } from "./config";
import { resolveCredentials } from "./credentials";
import { createLogFilePath, createLogger, flushLogger } from "./logger";
import { runMcpCommand } from "./mcp-cli";
import { collectModelsInUse } from "./model-configuration";
import { loadPromptFile } from "./prompt";
import { resolveProfile } from "./profile";
import { TaskCoordinator } from "./task-coordinator";
import { VoiceChatCoordinator } from "./voice-chat-coordinator";
import { DiscordAgent } from "@agents/discord/discord-agent";
import { createDiscordAgentTools } from "@agents/discord/discord-tools";
import {
  createPiAgentFactory,
  createPiModelRuntime,
  resolveConfiguredModel,
  withOpenCodeSessionHeader,
} from "@runtime/pi/pi-agent-runtime";
import { migratePiDurableStorage } from "@runtime/pi/pi-durable-migration";
import { createPiUsageReporterFromEnv } from "@runtime/pi/pi-usage-reporter";
import { createWatchFetchTool } from "@runtime/pi/watch-fetch-tool";
import { PiMemoryProcessor } from "@runtime/pi/pi-memory-processor";
import { PiVoiceReactionSelector } from "@runtime/pi/pi-voice-reaction-selector";
import { PiVoiceTranscriptQueueSelector } from "@runtime/pi/pi-voice-transcript-queue-selector";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import { resolveVoiceChatConfig } from "@modules/discord/domain/voice-chat-config";
import { DiscordJsService } from "@modules/discord/infrastructure/discord-js-service";
import { loadVoiceReactionPresets } from "@modules/discord/infrastructure/voice-reaction-presets";
import { FileDiscordAccessRuleStore } from "@modules/discord/infrastructure/file-discord-access-rule-store";
import { FileDiscordChannelRuleStore } from "@modules/discord/infrastructure/file-discord-channel-rule-store";
import { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import { resolveMemoryConfig } from "@modules/memory/application/memory-config";
import { JsonMemoryStore } from "@modules/memory/infrastructure/json-memory-store";
import {
  createWebUiMemoryAccessor,
  OwnerMemoryStore,
} from "@modules/memory/application/owner-memory-store";
import { createGetMonthlyUsageLimit } from "@modules/usage/application/get-monthly-usage-limit";
import { formatMonthlyUsageStatus } from "@modules/usage/application/format-monthly-usage-status";
import { resolveUsageProvider } from "@modules/usage/application/resolve-usage-provider";
import {
  resolveLogDirectory,
  resolveWebUiConfig,
  resolveWebUiStaticDirectory,
} from "@modules/webui/domain/webui-config";
import { startWebUi } from "@modules/webui/infrastructure/elysia-webui-app";
import { PinoJsonlReader } from "@modules/webui/infrastructure/pino-jsonl-reader";
import { PiSessionReader } from "@modules/webui/infrastructure/pi-session-reader";
import { PiToolUsageReader } from "@modules/webui/infrastructure/pi-tool-usage-reader";
import { Sbv2Tts } from "@modules/tts/infrastructure/sbv2-tts";
import { WebSocketAsrClient } from "@modules/asr/infrastructure/websocket-asr-client";
import { FileScheduledTaskStore } from "@modules/scheduling/infrastructure/file-scheduled-task-store";
import { QuickJsWatchCheckRunner } from "@modules/scheduling/application/quickjs-watch-check-runner";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";

const DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const CHANNEL_CONTEXT_ROTATION_CHECK_INTERVAL_MS = 60 * 1_000;
const SCHEDULED_TASK_CHECK_INTERVAL_MS = 10 * 1_000;

export async function bootstrap(): Promise<void> {
  const { sessionMode } = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig();
  const profile = resolveProfile(config.profile);
  const logDirectory = resolveLogDirectory(config);
  const logger = createLogger({ filePath: createLogFilePath(logDirectory) });
  const piUsageReporter = createPiUsageReporterFromEnv({ logger });
  logger.info({ event: "application_starting" }, "Starting Klein");

  const systemPrompt = await loadPromptFile(profile.systemPromptFile);
  const voiceChatConfig = resolveVoiceChatConfig(config);
  const memoryConfig = resolveMemoryConfig(config);
  const modelsInUse = collectModelsInUse(config);
  const credentials = resolveCredentials({ modelsInUse, environment: process.env });
  const discordOperatingState = new DiscordOperatingState();
  const ownerUserId = config.owner?.discord.userId;
  const voiceSystemPrompt = voiceChatConfig
    ? await loadPromptFile(profile.voiceSystemPromptFile)
    : undefined;
  const taskCoordinator = new TaskCoordinator();
  const tts = config.features.tts?.enabled ? new Sbv2Tts(config.features.tts.serverUrl) : undefined;
  const agentDir = resolve(config.runtime.agentDir);
  await migratePiDurableStorage({ agentDir, logger });
  const channelSessionStateStore = new ChannelSessionStateStore(
    resolve(agentDir, "channel-sessions"),
  );
  const scheduledTaskStore = new FileScheduledTaskStore(resolve(agentDir, "schedules"));
  const watchToolCatalog = { tools: [createWatchFetchTool({ agentDir })] };
  const watchCheckRunner = new QuickJsWatchCheckRunner({ tools: watchToolCatalog.tools });
  const channelRuleStore = new FileDiscordChannelRuleStore(resolve(agentDir, "channel-rules"));
  const discordAccessRuleStore = new FileDiscordAccessRuleStore(
    resolve(agentDir, "discord-access.json"),
  );
  await discordAccessRuleStore.load();
  const discordAccessPolicy = createDiscordAccessPolicy(
    config.discord.access,
    ownerUserId,
    discordAccessRuleStore,
  );
  const ownerMemoryStore = ownerUserId
    ? new OwnerMemoryStore(
        new JsonMemoryStore(
          resolve(config.owner?.memoryFilePath ?? resolve(agentDir, "owner-memory/MEMORY.json")),
        ),
      )
    : undefined;
  const modelRuntime = await createPiModelRuntime(agentDir);
  const providersInUse = new Set(modelsInUse.map((model) => model.provider));
  if (providersInUse.has("mistral") && !(await modelRuntime.checkAuth("mistral"))) {
    throw new Error("MISTRAL_API_KEY is required");
  }
  if (providersInUse.has("google") && !(await modelRuntime.checkAuth("google"))) {
    throw new Error("GEMINI_API_KEY is required");
  }
  const reactionConfiguration = voiceChatConfig?.reactions;
  const reactionPresets = reactionConfiguration
    ? await loadVoiceReactionPresets(reactionConfiguration.presetsFile)
    : undefined;
  const reactionClassifierModel = reactionConfiguration
    ? modelRuntime.getModelOfType(
        "classifier",
        reactionConfiguration.provider,
        reactionConfiguration.model,
      )
    : undefined;
  if (reactionConfiguration && !reactionClassifierModel) {
    throw new Error(
      `Voice chat classifier model was not found: ${reactionConfiguration.provider}/${reactionConfiguration.model}`,
    );
  }
  const reactionSelector = reactionClassifierModel
    ? new PiVoiceReactionSelector(modelRuntime, reactionClassifierModel, reactionPresets ?? [])
    : undefined;
  const transcriptQueueSelector = reactionClassifierModel
    ? new PiVoiceTranscriptQueueSelector(modelRuntime, reactionClassifierModel)
    : undefined;
  const piAgentFactory = createPiAgentFactory({
    agentDir,
    llm: config.llm,
    skillsDirectory: profile.skillsDirectory,
    logger,
    modelRuntime,
    sessionMode,
    permissions: config.permissions,
    usageReporter: piUsageReporter,
    watchToolCatalog,
  });
  const voiceChatAgentFactory = voiceChatConfig?.llm
    ? createPiAgentFactory({
        agentDir,
        llm: voiceChatConfig.llm,
        skillsDirectory: profile.skillsDirectory,
        logger,
        modelRuntime,
        sessionMode,
        permissions: config.permissions,
        usageReporter: piUsageReporter,
      })
    : piAgentFactory;
  let discordService!: DiscordJsService;
  let agentCoordinator!: AgentCoordinator;
  const createDiscordAgent = (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed = false,
  ) =>
    DiscordAgent.create(piAgentFactory, channelId, systemPrompt, {
      handoffContext,
      ownerFeaturesAllowed,
      ownerUserId,
      sessionKey,
      tools: (analyzeImage) =>
        createDiscordAgentTools(
          {
            channelApi: discordService,
            channelId,
            ownerFeaturesAllowed,
            ownerMemoryStore,
            ownerUserId,
            scheduledTaskStore,
            tts,
            watchCheckRunner,
          },
          analyzeImage,
        ),
    });
  const voiceChatCoordinator =
    voiceSystemPrompt === undefined
      ? undefined
      : new VoiceChatCoordinator({
          createVoiceChatAgent: (channelId, sessionKey, speak) =>
            DiscordAgent.create(voiceChatAgentFactory, channelId, voiceSystemPrompt, {
              sessionKey,
              tools: (analyzeImage) =>
                createDiscordAgentTools(
                  {
                    channelApi: discordService,
                    channelId,
                    ownerFeaturesAllowed: false,
                    speak,
                    watchCheckRunner,
                  },
                  analyzeImage,
                ),
            }),
          logger,
          reactionSelector,
          transcriptQueueSelector,
        });
  discordService = new DiscordJsService(
    credentials.discordBotToken,
    discordAccessPolicy,
    logger,
    discordOperatingState,
    voiceChatConfig && voiceChatCoordinator
      ? {
          asr: new WebSocketAsrClient(voiceChatConfig.asrServerUrl),
          conversationFactory: voiceChatCoordinator,
          language: voiceChatConfig.language,
          tts,
          ...(reactionPresets ? { reactionPresets } : {}),
        }
      : undefined,
    channelRuleStore,
    discordAccessRuleStore,
  );
  const memorySessionId = `memory-${randomUUID()}`;
  const memoryCoordinator = memoryConfig.enabled
    ? new MemoryCoordinator({
        filePath: memoryConfig.filePath,
        idleSeconds: memoryConfig.idleSeconds,
        logger,
        maxBatchAgeSeconds: memoryConfig.maxBatchAgeSeconds,
        maxBatchMessages: memoryConfig.maxBatchMessages,
        processor: new PiMemoryProcessor(
          withOpenCodeSessionHeader(
            resolveConfiguredModel(memoryConfig.llm.provider, memoryConfig.llm.model, modelRuntime),
            memorySessionId,
          ),
          memoryConfig.llm.thinkingLevel,
        ),
        taskCoordinator,
      })
    : undefined;
  agentCoordinator = new AgentCoordinator({
    accessPolicy: discordAccessPolicy,
    ownerUserId,
    createDiscordAgent,
    channelSessionStateStore,
    channelRuleStore,
    channelApi: discordService,
    logger,
    memoryCoordinator,
    ownerMemoryStore,
    operatingState: discordOperatingState,
    scheduledTaskStore,
    watchCheckRunner,
    taskCoordinator,
  });
  const usageProvider = resolveUsageProvider({
    agentDirectory: agentDir,
    provider: config.llm.provider,
    usage: credentials.usage,
    openCodeGoApiKey: credentials.openCodeGoApiKey,
  });
  const getMonthlyUsageLimit = usageProvider
    ? createGetMonthlyUsageLimit(usageProvider)
    : undefined;
  const updateDiscordUsageStatus = async (): Promise<void> => {
    try {
      if (!getMonthlyUsageLimit) return;
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
  const webUiMemory = createWebUiMemoryAccessor(ownerMemoryStore, memoryCoordinator);
  const webUi = webUiConfig.enabled
    ? await startWebUi({
        host: webUiConfig.host,
        logger,
        memory: webUiMemory,
        memoryEditor: webUiMemory,
        channelNames: {
          read: () => channelSessionStateStore.listChannelNames(),
        },
        piSessions: new PiSessionReader(agentDir, {
          read: () => channelSessionStateStore.listChannelNames(),
        }),
        pinoLogs: new PinoJsonlReader(logDirectory),
        toolUsage: new PiToolUsageReader(agentDir),
        port: webUiConfig.port,
        staticDirectory: resolveWebUiStaticDirectory(),
        tunnelToken: credentials.tunnelToken,
      })
    : undefined;

  let usageStatusInterval: ReturnType<typeof setInterval> | undefined;
  let contextRotationInterval: ReturnType<typeof setInterval> | undefined;
  let scheduledTaskCheckInterval: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown_started", signal }, "Shutting down");

    if (usageStatusInterval) {
      clearInterval(usageStatusInterval);
      usageStatusInterval = undefined;
    }
    if (contextRotationInterval) {
      clearInterval(contextRotationInterval);
      contextRotationInterval = undefined;
    }
    if (scheduledTaskCheckInterval) {
      clearInterval(scheduledTaskCheckInterval);
      scheduledTaskCheckInterval = undefined;
    }
    await webUi?.stop();
    discordService.stopAccepting();
    memoryCoordinator?.dispose();
    await taskCoordinator.waitForCompletion();
    await discordService.stop();
    await agentCoordinator.dispose();
    await piUsageReporter?.shutdown();
    logger.info({ event: "shutdown_completed" }, "Shutdown complete");
    flushLogger(logger);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    const pendingMessages: DiscordMessage[] = [];
    let restoring = true;
    await discordService.start((message) => {
      if (restoring) {
        pendingMessages.push(message);
        return Promise.resolve();
      }
      return agentCoordinator.handleDiscordMessage(message);
    });
    await agentCoordinator.initialize();
    restoring = false;
    await Promise.all(
      pendingMessages.map((message) => agentCoordinator.handleDiscordMessage(message)),
    );
  } catch (error) {
    await shutdown("startup_failed");
    throw error;
  }
  const runChannelContextRotationCheck = (): void => {
    void taskCoordinator
      .run(() => agentCoordinator.rotateIdleChannels())
      .catch((error: unknown) => {
        logger.error(
          { err: error, event: "channel_context_rotation_check_failed" },
          "Failed to check Discord channel context rotation",
        );
      });
  };
  runChannelContextRotationCheck();
  contextRotationInterval = setInterval(
    runChannelContextRotationCheck,
    CHANNEL_CONTEXT_ROTATION_CHECK_INTERVAL_MS,
  );
  void agentCoordinator.deliverDueTasks();
  scheduledTaskCheckInterval = setInterval(() => {
    void agentCoordinator.deliverDueTasks();
  }, SCHEDULED_TASK_CHECK_INTERVAL_MS);
  await updateDiscordUsageStatus();
  usageStatusInterval = setInterval(() => {
    void updateDiscordUsageStatus();
  }, DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS);
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "mcp") {
    try {
      process.exitCode = await runMcpCommand(args.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    await bootstrap();
  }
} catch (error) {
  createLogger().fatal({ err: error, event: "bootstrap_failed" }, "Klein failed to start");
  process.exitCode = 1;
}
