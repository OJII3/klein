import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator";
import { parseCliOptions } from "./cli-options";
import { loadConfig } from "./config";
import { createLogFilePath, createLogger, flushLogger } from "./logger";
import { loadPromptFile } from "./prompt";
import { resolveProfile } from "./profile";
import { TaskCoordinator } from "./task-coordinator";
import { VoiceChatCoordinator } from "./voice-chat-coordinator";
import { DiscordAgent } from "@agents/discord/discord-agent";
import {
  createPiModelRuntime,
  resolveConfiguredModel,
  withOpenCodeSessionHeader,
} from "@runtime/pi/pi-model-runtime";
import { createPiDurableAgentFactory } from "@runtime/pi/pi-durable-agent-runtime";
import { PiMemoryProcessor } from "@runtime/pi/pi-memory-processor";
import { PiVoiceReactionSelector } from "@runtime/pi/pi-voice-reaction-selector";
import { PiVoiceTranscriptQueueSelector } from "@runtime/pi/pi-voice-transcript-queue-selector";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import { DiscordJsService } from "@modules/discord/infrastructure/discord-js-service";
import { loadVoiceReactionPresets } from "@modules/discord/infrastructure/voice-reaction-presets";
import { FileDiscordChannelRuleStore } from "@modules/discord/infrastructure/file-discord-channel-rule-store";
import { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import { createGetMonthlyUsageLimit } from "@modules/usage/application/get-monthly-usage-limit";
import { formatMonthlyUsageStatus } from "@modules/usage/application/format-monthly-usage-status";
import { OpenCodeGoUsageProvider } from "@modules/usage/infrastructure/opencode-go-usage-provider";
import { VertexAiEstimatedUsageProvider } from "@modules/usage/infrastructure/vertex-ai-estimated-usage-provider";
import {
  resolveLogDirectory,
  resolveWebUiConfig,
  resolveWebUiStaticDirectory,
} from "@modules/webui/domain/webui-config";
import { startWebUi } from "@modules/webui/infrastructure/elysia-webui-app";
import { PinoJsonlReader } from "@modules/webui/infrastructure/pino-jsonl-reader";
import { Sbv2Tts } from "@modules/tts/infrastructure/sbv2-tts";
import { WebSocketAsrClient } from "@modules/asr/infrastructure/websocket-asr-client";
import { FileReminderStore } from "@modules/reminders/infrastructure/file-reminder-store";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";

const DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const CHANNEL_CONTEXT_ROTATION_CHECK_INTERVAL_MS = 60 * 1_000;
const REMINDER_CHECK_INTERVAL_MS = 10 * 1_000;

export async function bootstrap(): Promise<void> {
  const { sessionMode } = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig();
  const profile = resolveProfile(config.profile);
  const logDirectory = resolveLogDirectory(config);
  const logger = createLogger({ filePath: createLogFilePath(logDirectory) });
  logger.info({ event: "application_starting" }, "Starting Klein");

  const systemPrompt = await loadPromptFile(profile.systemPromptFile);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }
  const openCodeGoApiKey = process.env.OPENCODE_API_KEY;
  const voiceChatConfiguration = config.features.voiceChat;
  const voiceChatLlmConfiguration = voiceChatConfiguration?.enabled
    ? voiceChatConfiguration.llm
    : undefined;
  const memoryLlmConfiguration = config.features.memory.llm ?? config.llm;
  const modelsInUse = [config.llm, config.llm.image, voiceChatLlmConfiguration];
  if (config.features.memory.enabled) modelsInUse.push(memoryLlmConfiguration);
  const usesOpenCodeGo = modelsInUse.some((model) => model?.provider === "opencode-go");
  if (usesOpenCodeGo && !openCodeGoApiKey) {
    throw new Error("OPENCODE_API_KEY is required");
  }
  const discordOperatingState = new DiscordOperatingState();
  const ownerUserId = config.owner?.discord.userId;
  const discordAccessPolicy = createDiscordAccessPolicy(config.discord.access, ownerUserId);
  const voiceSystemPrompt = voiceChatConfiguration?.enabled
    ? await loadPromptFile(profile.voiceSystemPromptFile)
    : undefined;
  const taskCoordinator = new TaskCoordinator();
  const tts = config.features.tts?.enabled ? new Sbv2Tts(config.features.tts.serverUrl) : undefined;
  const agentDir = resolve(config.runtime.agentDir);
  const reminderStore = new FileReminderStore(resolve(agentDir, "reminders"));
  const channelRuleStore = new FileDiscordChannelRuleStore(resolve(agentDir, "channel-rules"));
  const modelRuntime = await createPiModelRuntime(agentDir);
  const reactionConfiguration = voiceChatConfiguration?.enabled
    ? voiceChatConfiguration.reactions
    : undefined;
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
  const piAgentFactory = createPiDurableAgentFactory({
    agentDir: resolve(agentDir, "pi-durable"),
    configDir: agentDir,
    llm: config.llm,
    skillsDirectory: profile.skillsDirectory,
    logger,
    modelRuntime,
    sessionMode,
    permissions: config.permissions,
  });
  const voiceChatAgentFactory = voiceChatLlmConfiguration
    ? createPiDurableAgentFactory({
        agentDir: resolve(agentDir, "pi-durable-voice"),
        configDir: agentDir,
        llm: voiceChatLlmConfiguration,
        skillsDirectory: profile.skillsDirectory,
        logger,
        modelRuntime,
        sessionMode,
        permissions: config.permissions,
      })
    : piAgentFactory;
  let discordService!: DiscordJsService;
  const createDiscordAgent = (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    ownerFeaturesAllowed = false,
  ) =>
    DiscordAgent.create(piAgentFactory, discordService, channelId, systemPrompt, {
      handoffContext,
      ownerFeaturesAllowed,
      ownerUserId,
      reminderStore,
      sessionKey,
      tts,
    });
  const voiceChatCoordinator =
    voiceSystemPrompt === undefined
      ? undefined
      : new VoiceChatCoordinator({
          createVoiceChatAgent: (channelId, sessionKey, speak) =>
            DiscordAgent.create(
              voiceChatAgentFactory,
              discordService,
              channelId,
              voiceSystemPrompt,
              {
                sessionKey,
                speak,
              },
            ),
          logger,
          reactionSelector,
          transcriptQueueSelector,
        });
  discordService = new DiscordJsService(
    token,
    discordAccessPolicy,
    logger,
    discordOperatingState,
    voiceChatConfiguration?.enabled && voiceChatCoordinator
      ? {
          asr: new WebSocketAsrClient(voiceChatConfiguration.asrServerUrl),
          conversationFactory: voiceChatCoordinator,
          language: voiceChatConfiguration.language ?? "ja",
          tts,
          ...(reactionPresets ? { reactionPresets } : {}),
        }
      : undefined,
    channelRuleStore,
  );
  const memoryConfiguration = config.features.memory;
  const resolvedMemoryLlmConfiguration = memoryConfiguration.llm ?? config.llm;
  const memorySessionId = `memory-${randomUUID()}`;
  const memoryCoordinator = memoryConfiguration.enabled
    ? new MemoryCoordinator({
        filePath: memoryConfiguration.filePath ?? ".runtime/memory/{guildId}/MEMORY.json",
        idleSeconds: memoryConfiguration.idleSeconds ?? 180,
        logger,
        maxBatchAgeSeconds: memoryConfiguration.maxBatchAgeSeconds ?? 1800,
        maxBatchMessages: memoryConfiguration.maxBatchMessages ?? 32,
        processor: new PiMemoryProcessor(
          withOpenCodeSessionHeader(
            resolveConfiguredModel(
              resolvedMemoryLlmConfiguration.provider,
              resolvedMemoryLlmConfiguration.model,
              modelRuntime,
            ),
            memorySessionId,
          ),
          resolvedMemoryLlmConfiguration.thinkingLevel,
        ),
        taskCoordinator,
      })
    : undefined;
  const agentCoordinator = new AgentCoordinator({
    accessPolicy: discordAccessPolicy,
    ownerUserId,
    createDiscordAgent,
    channelSessionStateStore: piAgentFactory.channelSessionStateStore,
    channelRuleStore,
    discordService,
    logger,
    memoryCoordinator,
    operatingState: discordOperatingState,
    reminderStore,
    taskCoordinator,
  });
  const usageProvider =
    config.llm.provider === "google-vertex"
      ? new VertexAiEstimatedUsageProvider(
          async (monthStart) =>
            (await piAgentFactory.getMonthlyProviderCost("google-vertex", monthStart)) +
            (voiceChatAgentFactory === piAgentFactory
              ? 0
              : await voiceChatAgentFactory.getMonthlyProviderCost("google-vertex", monthStart)),
        )
      : openCodeGoApiKey
        ? new OpenCodeGoUsageProvider(openCodeGoApiKey)
        : undefined;
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
  const webUi = webUiConfig.enabled
    ? await startWebUi({
        host: webUiConfig.host,
        logger,
        memory: memoryCoordinator,
        memoryEditor: memoryCoordinator,
        piSessions: piAgentFactory.sessions,
        pinoLogs: new PinoJsonlReader(logDirectory),
        port: webUiConfig.port,
        staticDirectory: resolveWebUiStaticDirectory(),
        tunnelToken: process.env.TUNNEL_TOKEN,
      })
    : undefined;

  let usageStatusInterval: ReturnType<typeof setInterval> | undefined;
  let contextRotationInterval: ReturnType<typeof setInterval> | undefined;
  let reminderCheckInterval: ReturnType<typeof setInterval> | undefined;
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
    if (reminderCheckInterval) {
      clearInterval(reminderCheckInterval);
      reminderCheckInterval = undefined;
    }
    await webUi?.stop();
    discordService.stopAccepting();
    memoryCoordinator?.dispose();
    await taskCoordinator.waitForCompletion();
    await discordService.stop();
    await agentCoordinator.dispose();
    await piAgentFactory.close();
    if (voiceChatAgentFactory !== piAgentFactory) await voiceChatAgentFactory.close();
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
    await piAgentFactory.resume();
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
  void agentCoordinator.deliverDueReminders();
  reminderCheckInterval = setInterval(() => {
    void agentCoordinator.deliverDueReminders();
  }, REMINDER_CHECK_INTERVAL_MS);
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
