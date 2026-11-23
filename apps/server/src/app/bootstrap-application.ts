import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { AgentCoordinator } from "./agent-coordinator";
import { WorkerAgentCoordinator, WORKER_SYSTEM_PROMPT } from "./worker-agent-coordinator";
import { FileWorkerStore } from "./worker-store";
import { ChannelSessionStateStore } from "./channel-session-state-store";
import { parseCliOptions } from "./cli-options";
import { loadConfig } from "./config";
import { resolveCredentials } from "./credentials";
import { createLogFilePath, createLogger, flushLogger } from "./logger";
import { collectModelsInUse } from "./model-configuration";
import { loadConversationSystemPrompt, loadPromptFile, PROACTIVITY_PROMPT_PATH } from "./prompt";
import { loadProfile } from "./profile";
import { createShutdownRunner } from "./shutdown";
import { TaskCoordinator } from "./task-coordinator";
import { VoiceChatCoordinator } from "./voice-chat-coordinator";
import { DiscordAgent } from "@agents/discord/discord-agent";
import { createDiscordAgentTools } from "@agents/discord/discord-tools";
import { createWorkerTools } from "@agents/discord/tools/worker";
import { createSecretTools } from "@agents/tools/secrets";
import {
  createPiAgentFactory,
  createPiModelRuntime,
  ensureConfiguredModels,
  resolveConfiguredModel,
} from "@runtime/pi/pi-agent-runtime";
import { PiStandaloneSessionRunner } from "@runtime/pi/pi-standalone-session-runner";
import { createPiMinimalAgentFactory } from "@runtime/pi/pi-minimal-agent-factory";
import { createPiUsageReporterFromEnv } from "@runtime/pi/pi-usage-reporter";
import { createT3CliThreadRunner } from "@runtime/t3/t3-cli-thread-runner";
import { createT3SqliteProjectLister } from "@runtime/t3/t3-sqlite-project-lister";
import { createWatchFetchTool } from "@runtime/pi/watch-fetch-tool";
import { runSandboxedCommand } from "@runtime/pi/user-shell-sandbox";
import { PiSharedMemoryAgent } from "@runtime/pi/pi-shared-memory-agent";
import { PiUserMemoryAgent } from "@runtime/pi/pi-user-memory-agent";
import { PiVoiceTranscriptQueueSelector } from "@runtime/pi/pi-voice-transcript-queue-selector";
import { createEvalFeedbackObserver } from "@runtime/pi/session-eval-store";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import { DiscordUserDirectory } from "@modules/discord/application/discord-user-directory";
import { resolveVoiceChatConfig } from "@modules/discord/domain/voice-chat-config";
import { DiscordJsService } from "@modules/discord/infrastructure/discord-js-service";
import { FileDiscordAccessRuleStore } from "@modules/discord/infrastructure/file-discord-access-rule-store";
import { FileDiscordAccessRequestStore } from "@modules/discord/infrastructure/file-discord-access-request-store";
import { FileDiscordChannelLinkStore } from "@modules/discord/infrastructure/file-discord-channel-link-store";
import { FileDiscordChannelLinkRequestStore } from "@modules/discord/infrastructure/file-discord-channel-link-request-store";
import { FileDiscordChannelRuleStore } from "@modules/discord/infrastructure/file-discord-channel-rule-store";
import { FileDiscordUserStore } from "@modules/discord/infrastructure/file-discord-user-store";
import { SharedMemoryCoordinator } from "@modules/shared-memory/application/shared-memory-coordinator";
import { resolveSharedMemoryConfig } from "@modules/shared-memory/application/shared-memory-config";
import { MarkdownSharedMemoryStore } from "@modules/shared-memory/infrastructure/markdown-shared-memory-store";
import { createWebUiSharedMemoryAccessor } from "@modules/shared-memory/application/shared-memory-web-accessor";
import { ProactiveCoordinator } from "@modules/proactivity/application/proactive-coordinator";
import { resolveProactivityConfig } from "@modules/proactivity/application/proactive-config";
import { FileFollowUpStore } from "@modules/proactivity/infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "@modules/proactivity/infrastructure/file-proactive-preference-store";
import { FileProactiveSignalStore } from "@modules/proactivity/infrastructure/file-proactive-signal-store";
import { InitiativeCoordinator } from "@modules/initiative/application/initiative-coordinator";
import { resolveInitiativeConfig } from "@modules/initiative/application/initiative-config";
import { FileInitiativeGoalStore } from "@modules/initiative/infrastructure/file-initiative-goal-store";
import { FilePlannerStateStore } from "@modules/initiative/infrastructure/file-planner-state-store";
import { PiConversationTranscriptReader } from "@modules/initiative/infrastructure/pi-conversation-transcript-reader";
import { PiInitiativePlanner } from "@modules/initiative/infrastructure/pi-initiative-planner";
import { MarkdownUserMemoryStore } from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { UserMemoryCoordinator } from "@modules/user-memory/application/user-memory-coordinator";
import { resolveUserMemoryConfig } from "@modules/user-memory/application/user-memory-config";
import { createGetMonthlyUsageLimit } from "@modules/usage/application/get-monthly-usage-limit";
import { formatMonthlyUsageStatus } from "@modules/usage/application/format-monthly-usage-status";
import { resolveUsageProvider } from "@modules/usage/infrastructure/resolve-usage-provider";
import {
  resolveLogDirectory,
  resolveWebUiConfig,
  resolveWebUiStaticDirectory,
} from "@modules/webui/domain/webui-config";
import { startWebUi } from "@modules/webui/infrastructure/elysia-webui-app";
import { PinoJsonlReader } from "@modules/webui/infrastructure/pino-jsonl-reader";
import { PiSessionReader } from "@modules/webui/infrastructure/pi-session-reader";
import { PiToolUsageReader } from "@modules/webui/infrastructure/pi-tool-usage-reader";
import { ProactivityStoreReader } from "@modules/webui/infrastructure/proactivity-store-reader";
import { Sbv2Tts } from "@modules/tts/infrastructure/sbv2-tts";
import { WebSocketAsrClient } from "@modules/asr/infrastructure/websocket-asr-client";
import { FileScheduledTaskStore } from "@modules/scheduling/infrastructure/file-scheduled-task-store";
import { QuickJsWatchCheckRunner } from "@modules/scheduling/infrastructure/quickjs-watch-check-runner";
import { SecretService } from "@modules/secrets/application/secret-service";
import { FileSecretStore } from "@modules/secrets/infrastructure/file-secret-store";
import { FileSecretRequestStore } from "@modules/secrets/infrastructure/file-secret-request-store";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordReactionEvent } from "@modules/discord/domain/discord-reaction";
import { accessScopeUserId, isOwnerAccessScope, parseAccessScope } from "@shared/access";
import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";

const DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const CHANNEL_CONTEXT_ROTATION_CHECK_INTERVAL_MS = 60 * 1_000;
const WORKER_IDLE_CHECK_INTERVAL_MS = 60 * 1_000;
const SCHEDULED_TASK_CHECK_INTERVAL_MS = 10 * 1_000;
const INITIATIVE_PLAN_CHECK_INTERVAL_MS = 60 * 1_000;
const SHUTDOWN_TIMEOUT_MS = 20 * 1_000;

export async function bootstrapApplication(): Promise<void> {
  const { sessionMode } = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig();
  const profile = await loadProfile(config.profile);
  const logDirectory = resolveLogDirectory(config);
  const logger = createLogger({ filePath: createLogFilePath(logDirectory) });
  const piUsageReporter = createPiUsageReporterFromEnv({ logger });
  logger.info({ event: "application_starting" }, "Starting Klein");

  const agentDir = resolve(config.runtime.agentDir);
  const proactivityConfig = resolveProactivityConfig(config, agentDir);
  const initiativeConfig = resolveInitiativeConfig(config, agentDir, proactivityConfig.enabled);
  const systemPrompt = await loadConversationSystemPrompt({
    systemPromptFile: profile.systemPromptFile,
    ...(proactivityConfig.enabled ? { proactivityPromptFile: PROACTIVITY_PROMPT_PATH } : {}),
  });
  const voiceChatConfig = resolveVoiceChatConfig(config);
  const sharedMemoryConfig = resolveSharedMemoryConfig(config);
  const modelsInUse = collectModelsInUse(config);
  const credentials = resolveCredentials({ modelsInUse, environment: process.env });
  const discordOperatingState = new DiscordOperatingState();
  const ownerUserId = config.owner?.discord.userId;
  const voiceSystemPrompt = voiceChatConfig
    ? await loadPromptFile(profile.voiceSystemPromptFile)
    : undefined;
  const taskCoordinator = new TaskCoordinator();
  const tts = config.features.tts?.enabled ? new Sbv2Tts(config.features.tts.serverUrl) : undefined;
  const discordUserDirectory = new DiscordUserDirectory(
    new FileDiscordUserStore(resolve(agentDir, "discord-users.json")),
    logger,
  );
  await discordUserDirectory.load();
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
  const discordAccessRequestStore = new FileDiscordAccessRequestStore(
    resolve(agentDir, "discord-access-requests.json"),
  );
  await discordAccessRequestStore.load();
  const discordChannelLinkStore = new FileDiscordChannelLinkStore(
    resolve(agentDir, "discord-channel-links.json"),
  );
  await discordChannelLinkStore.load();
  const discordChannelLinkRequestStore = new FileDiscordChannelLinkRequestStore(
    resolve(agentDir, "discord-channel-link-requests.json"),
  );
  await discordChannelLinkRequestStore.load();
  const discordAccessPolicy = createDiscordAccessPolicy(
    config.discord.access,
    ownerUserId,
    discordAccessRuleStore,
    (target) => discordChannelLinkStore.getLink(target)?.userId,
  );
  const userMemoryConfig = resolveUserMemoryConfig(config);
  const userMemoryDirectory =
    userMemoryConfig?.enabled === true
      ? userMemoryConfig.directory
        ? resolve(userMemoryConfig.directory)
        : resolve(agentDir, "user-memory")
      : undefined;
  const userMemoryStore = userMemoryDirectory
    ? new MarkdownUserMemoryStore(userMemoryDirectory)
    : undefined;
  const modelRuntime = await createPiModelRuntime(agentDir);
  const providersInUse = new Set(modelsInUse.map((model) => model.provider));
  if (providersInUse.has("mistral") && !(await modelRuntime.checkAuth("mistral"))) {
    throw new Error("MISTRAL_API_KEY is required");
  }
  if (providersInUse.has("google") && !(await modelRuntime.checkAuth("google"))) {
    throw new Error("GEMINI_API_KEY is required");
  }
  await ensureConfiguredModels(modelRuntime, modelsInUse);
  const initiativeModel = initiativeConfig.enabled
    ? resolveConfiguredModel(
        initiativeConfig.llm.provider,
        initiativeConfig.llm.model,
        modelRuntime,
      )
    : undefined;
  const initiativePlanner = initiativeModel
    ? new PiInitiativePlanner(modelRuntime, initiativeModel, initiativeConfig.llm.thinkingLevel)
    : undefined;
  const sessionRunner = new PiStandaloneSessionRunner({
    agentDir,
    logger,
    modelRuntime,
    usageReporter: piUsageReporter,
  });
  const classifierConfiguration = voiceChatConfig?.classifier;
  const classifierModel = classifierConfiguration
    ? modelRuntime.getModelOfType(
        "classifier",
        classifierConfiguration.provider,
        classifierConfiguration.model,
      )
    : undefined;
  if (classifierConfiguration && !classifierModel) {
    throw new Error(
      `Voice chat classifier model was not found: ${classifierConfiguration.provider}/${classifierConfiguration.model}`,
    );
  }
  const transcriptQueueSelector = classifierModel
    ? new PiVoiceTranscriptQueueSelector(modelRuntime, classifierModel)
    : undefined;
  const evalFeedbackObserver = createEvalFeedbackObserver({
    agentDir,
    accessPolicy: discordAccessPolicy,
    ownerUserId,
    logger,
    runTask: (work) => taskCoordinator.run(work),
  });
  const piAgentFactory = createPiAgentFactory({
    agentDir,
    characterName: profile.characterName,
    llm: config.llm,
    skillsDirectory: profile.skillsDirectory,
    logger,
    modelRuntime,
    sessionMode,
    permissions: config.permissions,
    usageReporter: piUsageReporter,
    watchToolCatalog,
    onSessionCreated: (session, context) =>
      context.role.kind === "conversation"
        ? evalFeedbackObserver.observeSession(session, context)
        : undefined,
  });
  const voiceChatAgentFactory = voiceChatConfig?.llm
    ? createPiAgentFactory({
        agentDir,
        characterName: profile.characterName,
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
  let sharedMemoryCoordinator: SharedMemoryCoordinator | undefined;
  const t3ThreadRunner = createT3CliThreadRunner();
  const t3ProjectLister = createT3SqliteProjectLister();
  let workerAgentCoordinator!: WorkerAgentCoordinator;
  const secretService = new SecretService({
    secrets: new FileSecretStore(agentDir, logger),
    requests: new FileSecretRequestStore(resolve(agentDir, "secret-requests.json")),
    onResolved: async (request, outcome) => {
      const scope = parseAccessScope(request.accessScope);
      if (!scope) return;
      const sent = await workerAgentCoordinator.send(
        {
          conversationKey: { kind: "discord", channelId: request.channelId },
          accessScope: scope,
        },
        request.workerId,
        outcome === "saved"
          ? `Secret "${request.label}" (${request.service}) was saved. Use secret_list to confirm it and secret_run to use it.`
          : `Secret "${request.label}" (${request.service}) input was cancelled. Use secret_request to ask again if needed.`,
      );
      if (!sent) {
        logger.info(
          {
            event: "secret_request_worker_unavailable",
            requestId: request.requestId,
            workerId: request.workerId,
          },
          "The worker for a secret request is no longer available",
        );
      }
    },
    logger,
  });
  await secretService.load();
  workerAgentCoordinator = new WorkerAgentCoordinator({
    factory: piAgentFactory,
    systemPrompt: WORKER_SYSTEM_PROMPT,
    logger,
    store: new FileWorkerStore(resolve(agentDir, "workers")),
    taskCoordinator,
    hasOwnedWatches: async ({ id, conversationKey, accessScope }) => {
      const scope = parseAccessScope(accessScope);
      if (!scope) return false;
      const watches = await scheduledTaskStore.listForScope(
        "watch",
        conversationKey.channelId,
        scope,
      );
      return watches.some((watch) => watch.ownerWorkerId === id);
    },
    createTools: (conversationKey, accessScope, workerId, toolContext) => {
      const ownerRequester =
        ownerUserId && isOwnerAccessScope(accessScope, ownerUserId)
          ? { userId: ownerUserId }
          : undefined;
      const workerTools = createWorkerTools(
        discordService,
        conversationKey.channelId,
        accessScope,
        workerId,
        scheduledTaskStore,
        watchCheckRunner,
        ownerRequester,
        toolContext.analyzeImage,
        ownerRequester ? t3ThreadRunner : undefined,
        ownerRequester ? t3ProjectLister : undefined,
        { users: discordUserDirectory, profiles: discordService },
      );
      const workerUserId = accessScopeUserId(accessScope);
      if (!workerUserId) return workerTools;
      return [
        ...workerTools,
        ...createSecretTools({
          secrets: secretService,
          userId: workerUserId,
          channelId: conversationKey.channelId,
          accessScope,
          workerId,
          environment: ensureUserEnvironment(resolveUserEnvironment(agentDir, workerUserId)),
          runCommand: runSandboxedCommand,
        }),
      ];
    },
    onResult: (delivery) =>
      agentCoordinator.deliverWorkerResult(
        delivery.conversationKey,
        delivery.accessScope,
        delivery.result,
      ),
    onWorkerClosed: async ({ id, conversationKey, accessScope }) => {
      const scope = parseAccessScope(accessScope);
      if (!scope) return;
      const watches = await scheduledTaskStore.listForScope(
        "watch",
        conversationKey.channelId,
        scope,
      );
      for (const watch of watches) {
        if (watch.ownerWorkerId !== id) continue;
        const { ownerWorkerId: _ownerWorkerId, ...rest } = watch;
        await scheduledTaskStore.update(rest);
      }
    },
  });
  const proactivePreferenceStore = new FileProactivePreferenceStore(
    proactivityConfig.preferencesDirectory,
  );
  const proactiveFollowUpStore = new FileFollowUpStore(proactivityConfig.followUpDirectory);
  const proactiveSignalStore = new FileProactiveSignalStore(proactivityConfig.signalDirectory);
  let initiativeCoordinator: InitiativeCoordinator | undefined;
  const proactiveCoordinator = proactivityConfig.enabled
    ? new ProactiveCoordinator({
        preferenceStore: proactivePreferenceStore,
        followUpStore: proactiveFollowUpStore,
        signalStore: proactiveSignalStore,
        scheduledTaskStore,
        workers: workerAgentCoordinator,
        defaults: proactivityConfig.defaults,
        onSignalSurfaced: async (signal, _mode, now) => {
          if (signal.source.kind !== "goal" || signal.source.ref === undefined) return;
          await initiativeCoordinator?.markResultDelivered(signal.source.ref, now);
        },
        logger,
      })
    : undefined;
  const initiativeGoalStore = initiativeConfig.enabled
    ? new FileInitiativeGoalStore(initiativeConfig.goalsDirectory)
    : undefined;
  const initiativePlannerStateStore = initiativeConfig.enabled
    ? new FilePlannerStateStore(initiativeConfig.plannerStateDirectory)
    : undefined;
  initiativeCoordinator =
    initiativeConfig.enabled &&
    initiativePlanner &&
    initiativeGoalStore &&
    initiativePlannerStateStore &&
    proactiveCoordinator
      ? new InitiativeCoordinator({
          config: initiativeConfig,
          goalStore: initiativeGoalStore,
          plannerStateStore: initiativePlannerStateStore,
          channelStateStore: channelSessionStateStore,
          transcriptReader: new PiConversationTranscriptReader(agentDir),
          preferenceStore: proactivePreferenceStore,
          planner: initiativePlanner,
          proactive: proactiveCoordinator,
          workers: workerAgentCoordinator,
          operatingState: discordOperatingState,
          ...(userMemoryStore ? { userMemoryStore } : {}),
          getChannelLocation: (channelId) => discordService.getChannelLocation(channelId),
          getSharedMemory: (location) =>
            sharedMemoryCoordinator?.getContext(location) ?? Promise.resolve(undefined),
          ...(ownerUserId ? { ownerUserId } : {}),
          logger,
        })
      : undefined;
  if (initiativeConfig.enabled && !initiativeCoordinator) {
    logger.warn(
      { event: "initiative_disabled_missing_dependencies" },
      "Initiative is enabled but its dependencies are unavailable",
    );
  }
  const createDiscordAgent = (
    channelId: string,
    sessionKey: string,
    handoffContext?: string,
    accessScope?: string,
  ) => {
    const ownerFeaturesAllowed = isOwnerAccessScope(accessScope, ownerUserId);
    const scope = parseAccessScope(accessScope);
    return DiscordAgent.create(piAgentFactory, channelId, systemPrompt, {
      accessScope: scope,
      handoffContext,
      ownerFeaturesAllowed,
      ownerUserId,
      sessionKey,
      tools: (toolContext) =>
        createDiscordAgentTools({
          accessScope: scope,
          analyzeImage: toolContext.analyzeImage,
          channelApi: discordService,
          channelId,
          discordUserDirectory,
          ownerFeaturesAllowed,
          ownerUserId,
          requesterUserId: toolContext.requesterId,
          scheduledTaskStore,
          sessionFilePath: toolContext.sessionFilePath,
          tts,
          userMemoryStore,
          watchCheckRunner,
          workers: workerAgentCoordinator,
          ...(ownerFeaturesAllowed ? { t3ProjectLister } : {}),
          promiseGuard: { mode: proactivityConfig.promiseGuard, logger },
          ...(proactiveCoordinator ? { proactive: proactiveCoordinator } : {}),
          ...(initiativeCoordinator ? { initiative: initiativeCoordinator } : {}),
        }),
    });
  };
  const userMemoryCoordinator =
    userMemoryConfig?.enabled === true && userMemoryStore && userMemoryDirectory
      ? new UserMemoryCoordinator({
          store: userMemoryStore,
          processor: new PiUserMemoryAgent({
            directory: userMemoryDirectory,
            factory: createPiMinimalAgentFactory({
              runner: sessionRunner,
              model: resolveConfiguredModel(
                userMemoryConfig.llm.provider,
                userMemoryConfig.llm.model,
                modelRuntime,
              ),
              cwd: process.cwd(),
              ...(userMemoryConfig.llm.thinkingLevel
                ? { thinkingLevel: userMemoryConfig.llm.thinkingLevel }
                : {}),
            }),
          }),
          logger,
          taskCoordinator,
        })
      : undefined;
  const voiceChatCoordinator =
    voiceSystemPrompt === undefined
      ? undefined
      : new VoiceChatCoordinator({
          createVoiceChatAgent: (channelId, sessionKey, speak) =>
            DiscordAgent.create(voiceChatAgentFactory, channelId, voiceSystemPrompt, {
              sessionKey,
              tools: (toolContext) =>
                createDiscordAgentTools({
                  analyzeImage: toolContext.analyzeImage,
                  channelApi: discordService,
                  channelId,
                  discordUserDirectory,
                  ownerFeaturesAllowed: false,
                  requesterUserId: toolContext.requesterId,
                  sessionFilePath: toolContext.sessionFilePath,
                  speak,
                  userMemoryStore,
                  watchCheckRunner,
                  workers: workerAgentCoordinator,
                }),
            }),
          logger,
          discordUserDirectory,
          transcriptQueueSelector,
          userMemoryCoordinator,
        });
  discordService = new DiscordJsService(
    credentials.discordBotToken,
    discordAccessPolicy,
    logger,
    discordOperatingState,
    voiceChatConfig && voiceChatCoordinator
      ? {
          asr: new WebSocketAsrClient(voiceChatConfig.asrServerUrl),
          characterName: profile.characterName,
          conversationFactory: voiceChatCoordinator,
          language: voiceChatConfig.language,
          tts,
        }
      : undefined,
    channelRuleStore,
    discordAccessRuleStore,
    ownerUserId,
    discordAccessRequestStore,
    {
      enableReactions: true,
      channelLinkStore: discordChannelLinkStore,
      channelLinkRequestStore: discordChannelLinkRequestStore,
      secrets: secretService,
    },
  );
  const memorySessionId = `memory-${randomUUID()}`;
  sharedMemoryCoordinator = sharedMemoryConfig.enabled
    ? new SharedMemoryCoordinator({
        store: new MarkdownSharedMemoryStore(sharedMemoryConfig.directory),
        idleSeconds: sharedMemoryConfig.idleSeconds,
        logger,
        maxBatchAgeSeconds: sharedMemoryConfig.maxBatchAgeSeconds,
        maxBatchMessages: sharedMemoryConfig.maxBatchMessages,
        processor: new PiSharedMemoryAgent({
          directory: sharedMemoryConfig.directory,
          sessionId: memorySessionId,
          createFactory: (directory) =>
            createPiMinimalAgentFactory({
              runner: sessionRunner,
              model: resolveConfiguredModel(
                sharedMemoryConfig.llm.provider,
                sharedMemoryConfig.llm.model,
                modelRuntime,
              ),
              cwd: directory,
              ...(sharedMemoryConfig.llm.thinkingLevel
                ? { thinkingLevel: sharedMemoryConfig.llm.thinkingLevel }
                : {}),
            }),
        }),
        taskCoordinator,
      })
    : undefined;
  agentCoordinator = new AgentCoordinator({
    accessPolicy: discordAccessPolicy,
    workers: workerAgentCoordinator,
    ownerUserId,
    createDiscordAgent,
    channelSessionStateStore,
    channelRuleStore,
    channelApi: discordService,
    logger,
    discordUserDirectory,
    sharedMemoryCoordinator,
    operatingState: discordOperatingState,
    ...(proactiveCoordinator ? { proactive: proactiveCoordinator } : {}),
    ...(initiativeCoordinator ? { initiative: initiativeCoordinator } : {}),
    scheduledTaskStore,
    userMemoryCoordinator,
    userMemoryStore,
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
  const webUiMemory = createWebUiSharedMemoryAccessor(sharedMemoryCoordinator);
  const webUi = webUiConfig.enabled
    ? await startWebUi({
        displayName: profile.displayName,
        host: webUiConfig.host,
        logger,
        memory: webUiMemory,
        memoryEditor: webUiMemory,
        userMemory: userMemoryStore,
        userMemoryEditor: userMemoryStore,
        channelNames: {
          read: () => channelSessionStateStore.listChannelNames(),
        },
        guildNames: {
          read: async () => discordService.listGuildNames(),
        },
        piSessions: new PiSessionReader(agentDir, {
          read: () => channelSessionStateStore.listChannelNames(),
        }),
        pinoLogs: new PinoJsonlReader(logDirectory),
        toolUsage: new PiToolUsageReader(agentDir),
        ...(proactivityConfig.enabled
          ? {
              proactivity: new ProactivityStoreReader({
                preferenceStore: proactivePreferenceStore,
                followUpStore: proactiveFollowUpStore,
                signalStore: proactiveSignalStore,
                ...(initiativeGoalStore ? { goalStore: initiativeGoalStore } : {}),
              }),
            }
          : {}),
        port: webUiConfig.port,
        staticDirectory: resolveWebUiStaticDirectory(),
        cloudflaredEnabled: webUiConfig.cloudflaredEnabled,
        tunnelToken: credentials.tunnelToken,
      })
    : undefined;

  let usageStatusInterval: ReturnType<typeof setInterval> | undefined;
  let contextRotationInterval: ReturnType<typeof setInterval> | undefined;
  let workerCleanupInterval: ReturnType<typeof setInterval> | undefined;
  let scheduledTaskCheckInterval: ReturnType<typeof setInterval> | undefined;
  let initiativePlanInterval: ReturnType<typeof setInterval> | undefined;
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: "shutdown_started", signal }, "Shutting down");

    if (usageStatusInterval) {
      clearInterval(usageStatusInterval);
      usageStatusInterval = undefined;
    }
    if (contextRotationInterval) {
      clearInterval(contextRotationInterval);
      contextRotationInterval = undefined;
    }
    if (workerCleanupInterval) {
      clearInterval(workerCleanupInterval);
      workerCleanupInterval = undefined;
    }
    if (scheduledTaskCheckInterval) {
      clearInterval(scheduledTaskCheckInterval);
      scheduledTaskCheckInterval = undefined;
    }
    if (initiativePlanInterval) {
      clearInterval(initiativePlanInterval);
      initiativePlanInterval = undefined;
    }
    await webUi?.stop();
    discordService.stopAccepting();
    await workerAgentCoordinator.dispose();
    await Promise.all([sharedMemoryCoordinator?.flush(), userMemoryCoordinator?.flush()]);
    sharedMemoryCoordinator?.dispose();
    userMemoryCoordinator?.dispose();
    await taskCoordinator.waitForCompletion();
    await discordService.stop();
    await agentCoordinator.dispose();
    await evalFeedbackObserver.flush();
    await discordUserDirectory.flush();
    await piUsageReporter?.shutdown();
    logger.info({ event: "shutdown_completed" }, "Shutdown complete");
    flushLogger(logger);
  };

  const runShutdown = createShutdownRunner({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    shutdown,
    onTimeout: (signal) => {
      logger.error(
        { event: "shutdown_timeout", signal },
        "Shutdown did not finish in time; forcing exit",
      );
    },
    onError: (error, signal) => {
      logger.error({ err: error, event: "shutdown_failed", signal }, "Shutdown failed");
    },
    exit: (code) => process.exit(code),
  });

  process.once("SIGINT", () => {
    void runShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void runShutdown("SIGTERM");
  });

  try {
    const pendingMessages: DiscordMessage[] = [];
    const pendingReactions: DiscordReactionEvent[] = [];
    let restoring = true;
    await workerAgentCoordinator.load();
    await discordService.start(
      (message) => {
        if (restoring) {
          pendingMessages.push(message);
          return Promise.resolve();
        }
        return agentCoordinator.handleDiscordMessage(message);
      },
      (reaction) => {
        if (restoring) {
          pendingReactions.push(reaction);
          return Promise.resolve();
        }
        return discordOperatingState.isActive()
          ? evalFeedbackObserver.handleReaction(reaction)
          : Promise.resolve();
      },
    );
    await agentCoordinator.initialize();
    restoring = false;
    await Promise.all([
      ...pendingMessages.map((message) => agentCoordinator.handleDiscordMessage(message)),
      ...pendingReactions.map((reaction) =>
        discordOperatingState.isActive()
          ? evalFeedbackObserver.handleReaction(reaction)
          : Promise.resolve(),
      ),
    ]);
  } catch (error) {
    logger.fatal({ err: error, event: "startup_failed" }, "Klein failed to start");
    await runShutdown("startup_failed", 1);
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
  const runWorkerIdleCleanup = (): void => {
    void taskCoordinator
      .run(async () => {
        await workerAgentCoordinator.closeIdleWorkers();
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error, event: "worker_idle_cleanup_failed" },
          "Failed to close idle workers",
        );
      });
  };
  runWorkerIdleCleanup();
  workerCleanupInterval = setInterval(runWorkerIdleCleanup, WORKER_IDLE_CHECK_INTERVAL_MS);
  const runInitiativePlan = (): void => {
    if (!initiativeCoordinator) return;
    void taskCoordinator
      .run(() => initiativeCoordinator.planDueChannels())
      .catch((error: unknown) => {
        logger.warn(
          { err: error, event: "initiative_plan_check_failed" },
          "Failed to check initiative planning",
        );
      });
  };
  const runInitiativeGoalDelivery = (): void => {
    if (!initiativeCoordinator) return;
    void taskCoordinator
      .run(() => initiativeCoordinator.deliverDueGoals())
      .catch((error: unknown) => {
        logger.warn(
          { err: error, event: "initiative_goal_check_failed" },
          "Failed to check due initiative goals",
        );
      });
  };
  void agentCoordinator.deliverDueTasks();
  void agentCoordinator.deliverDueDigests();
  runInitiativeGoalDelivery();
  runInitiativePlan();
  scheduledTaskCheckInterval = setInterval(() => {
    void agentCoordinator.deliverDueTasks();
    void agentCoordinator.deliverDueDigests();
    runInitiativeGoalDelivery();
  }, SCHEDULED_TASK_CHECK_INTERVAL_MS);
  initiativePlanInterval = setInterval(runInitiativePlan, INITIATIVE_PLAN_CHECK_INTERVAL_MS);
  await updateDiscordUsageStatus();
  usageStatusInterval = setInterval(() => {
    void updateDiscordUsageStatus();
  }, DISCORD_USAGE_STATUS_REFRESH_INTERVAL_MS);
}
