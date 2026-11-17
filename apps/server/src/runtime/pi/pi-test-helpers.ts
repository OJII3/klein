import type {
  Api,
  AssistantMessage,
  ClassifierApi,
  ClassifierModel,
  ClassifierResult,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createEventBus,
  createExtensionRuntime,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Extension,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type RegisteredTool,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type ToolDefinition,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord } from "@shared/type-guards";
import type { PiRuntimeSession } from "./pi-agent-runtime";
import type { PiTraceSession } from "./pi-runtime-trace";

export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export async function createTestModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
}

const sharedTestModelRuntime = await createTestModelRuntime();

export function createTestModelRegistry(
  runtime: ModelRuntime = sharedTestModelRuntime,
): ModelRegistry {
  return new ModelRegistry(runtime);
}

export function createStubUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

export function createStubModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

export function createStubClassifierModel(
  overrides: Partial<ClassifierModel<ClassifierApi>> = {},
): ClassifierModel<ClassifierApi> {
  return {
    type: "classifier",
    id: "jev",
    name: "Test Classifier",
    api: "typesafe-system-one",
    provider: "test",
    baseUrl: "https://example.invalid/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    ...overrides,
  };
}

export function createStubAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: createStubUsage(),
    stopReason: "stop",
    timestamp: 1_794_000_000_000,
    ...overrides,
  };
}

export function createStubClassifierResult(
  choice: string,
  confidence = 0.9,
  stopReason: ClassifierResult["stopReason"] = "stop",
): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "test",
    model: "jev",
    answers: {
      reaction: {
        type: "choice",
        choice,
        confidence,
        probabilities: {},
      },
    },
    stopReason,
    timestamp: 1_794_000_000_000,
  };
}

const emptySchema = Type.Object({});

export function createStubToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? "stub-tool",
    label: overrides.label ?? overrides.name ?? "Stub Tool",
    description: overrides.description ?? "Stub tool for tests",
    parameters: overrides.parameters ?? emptySchema,
    execute:
      overrides.execute ??
      (async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      })),
    ...overrides,
  };
}

export function createStubExtensionUIContext(): ExtensionUIContext {
  const runner = new ExtensionRunner(
    [],
    createExtensionRuntime(),
    "/tmp",
    SessionManager.inMemory(),
    createTestModelRegistry(),
  );
  return runner.getUIContext();
}

export function createStubExtensionContext(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  return {
    ui: overrides.ui ?? createStubExtensionUIContext(),
    mode: overrides.mode ?? "print",
    hasUI: overrides.hasUI ?? false,
    cwd: overrides.cwd ?? "/tmp",
    sessionManager: overrides.sessionManager ?? SessionManager.inMemory(),
    modelRegistry: overrides.modelRegistry ?? createTestModelRegistry(),
    model: overrides.model,
    scopedModels: overrides.scopedModels ?? [],
    thinkingLevel: overrides.thinkingLevel,
    isIdle: overrides.isIdle ?? (() => true),
    isProjectTrusted: overrides.isProjectTrusted ?? (() => true),
    signal: overrides.signal,
    abort: overrides.abort ?? (() => undefined),
    hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
    shutdown: overrides.shutdown ?? (() => undefined),
    getContextUsage: overrides.getContextUsage ?? (() => undefined),
    compact: overrides.compact ?? (() => undefined),
    getSystemPrompt: overrides.getSystemPrompt ?? (() => ""),
  };
}

export function createStubExtensionToolContext(
  overrides: Partial<ExtensionToolContext> = {},
): ExtensionToolContext {
  return {
    ...createStubExtensionContext(overrides),
    tools: overrides.tools ?? [],
    executeTool:
      overrides.executeTool ??
      (async (name, _args) => ({
        toolCall: { type: "toolCall", id: "tool-call-1", name, arguments: {} },
        result: {
          content: [{ type: "text", text: "" }],
          details: {},
        },
        isError: false,
      })),
  };
}

export type RegisteredToolSummary = Pick<
  ToolDefinition,
  "name" | "label" | "description" | "exposure" | "namespace" | "annotations" | "defaultActive"
>;

export function createStubExtensionApi(
  options: {
    readonly onRegisterTool?: (tool: RegisteredToolSummary) => void;
  } = {},
): ExtensionAPI {
  return {
    on: () => () => undefined,
    registerTool(tool) {
      options.onRegisterTool?.({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        exposure: tool.exposure,
        namespace: tool.namespace,
        annotations: tool.annotations,
        defaultActive: tool.defaultActive,
      });
    },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    registerMarkdownTransformer: () => undefined,
    registerEntryRenderer: () => undefined,
    registerToolRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: () => undefined,
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false, truncated: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getSettings: () => SettingsManager.inMemory().getSettings(),
    setActiveTools: () => undefined,
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => undefined,
    registerProvider: () => undefined,
    unregisterProvider: () => undefined,
    registerMcpServer: () => undefined,
    unregisterMcpServer: () => undefined,
    getMcpServers: () => [],
    registerVirtualModel: () => undefined,
    unregisterVirtualModel: () => undefined,
    events: createEventBus(),
  };
}

export async function loadTestExtension(factory: ExtensionFactory): Promise<Extension> {
  const loader = new DefaultResourceLoader({
    cwd: "/tmp",
    agentDir: "/tmp",
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [factory],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const ext = loader.getExtensions().extensions[0];
  if (!ext) {
    throw new Error("Failed to load test extension");
  }
  return ext;
}

export function createStubTurnEndEvent(overrides: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: overrides.turnIndex ?? 0,
    message: overrides.message ?? createStubAssistantMessage(),
    toolResults: overrides.toolResults ?? [],
    messageEntryId: overrides.messageEntryId ?? "msg-1",
    toolResultEntryIds: overrides.toolResultEntryIds ?? [],
    entries: overrides.entries ?? [],
    continue: overrides.continue ?? false,
    context: overrides.context ?? {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
    outcome: overrides.outcome ?? "completed",
  };
}

export function createStubCompactionPreparation(
  overrides: Partial<CompactionPreparation> = {},
): CompactionPreparation {
  return {
    firstKeptEntryId: overrides.firstKeptEntryId ?? "entry-1",
    messagesToSummarize: overrides.messagesToSummarize ?? [],
    turnPrefixMessages: overrides.turnPrefixMessages ?? [],
    isSplitTurn: overrides.isSplitTurn ?? false,
    tokensBefore: overrides.tokensBefore ?? 1000,
    previousSummary: overrides.previousSummary,
    fileOps: overrides.fileOps ?? {
      read: new Set<string>(),
      written: new Set<string>(),
      edited: new Set<string>(),
    },
    settings: overrides.settings ?? SettingsManager.inMemory().getCompactionSettings(),
  };
}

export function createStubSessionBeforeCompactEvent(
  overrides: Partial<SessionBeforeCompactEvent> & {
    readonly preparation: CompactionPreparation;
    readonly branchEntries: SessionEntry[];
  },
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    reason: overrides.reason ?? "threshold",
    willRetry: overrides.willRetry ?? false,
    signal: overrides.signal ?? new AbortController().signal,
    customInstructions: overrides.customInstructions,
    preparation: overrides.preparation,
    branchEntries: overrides.branchEntries,
  };
}

export function createStubPiTraceSession(overrides: Partial<PiTraceSession> = {}): PiTraceSession {
  const sessionManager = overrides.sessionManager ?? SessionManager.inMemory();
  const settingsManager = overrides.settingsManager ?? SettingsManager.inMemory();
  return {
    sessionManager,
    settingsManager,
    model: overrides.model,
    thinkingLevel: overrides.thinkingLevel ?? "off",
    steeringMode: overrides.steeringMode ?? "one-at-a-time",
    cacheWarmingStatus: overrides.cacheWarmingStatus,
    subscribe: overrides.subscribe ?? (() => () => undefined),
    abort: overrides.abort ?? (async () => undefined),
  };
}

export function createStubPiRuntimeSession(
  overrides: Partial<PiRuntimeSession> = {},
): PiRuntimeSession {
  const traceSession = createStubPiTraceSession(overrides);
  const sessionManager = overrides.sessionManager ?? SessionManager.inMemory();
  return {
    ...traceSession,
    sessionManager,
    isStreaming: overrides.isStreaming ?? false,
    messages: overrides.messages ?? [],
    prompt: overrides.prompt ?? (async () => undefined),
    steer: overrides.steer ?? (async () => "queued"),
    sendCustomMessage: overrides.sendCustomMessage ?? (async () => undefined),
    compact:
      overrides.compact ??
      (async () => ({
        summary: "",
        firstKeptEntryId: "entry-1",
        tokensBefore: 0,
      })),
    dispose: overrides.dispose ?? (() => undefined),
  };
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function extractContextMessagesResult(result: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(result) || !isUnknownArray(result.messages)) {
    throw new Error("Expected context handler result with messages array");
  }
  const messages: Record<string, unknown>[] = [];
  for (const item of result.messages) {
    if (!isRecord(item) || typeof item.role !== "string") {
      throw new Error("Expected message object in context handler result");
    }
    messages.push(item);
  }
  return messages;
}

export function getRegisteredToolDefinition(
  tools: Map<string, RegisteredTool>,
  name: string,
): ToolDefinition {
  const registered = tools.get(name);
  if (!registered) {
    throw new Error(`Expected registered tool ${name}`);
  }
  return registered.definition;
}
