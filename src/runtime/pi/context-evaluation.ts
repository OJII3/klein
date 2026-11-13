import {
  createAssistantMessageEventStream,
  createFauxCore,
  createInitialSystemMessage,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getSystemMessageText,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FauxResponseStep,
  type ImageContent,
  type Message,
  type Model,
  type ModelsSimpleStreamOptions,
  type SystemMessage,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  type ContextWithSystemEvent,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import { createDiscordAgentTools } from "@agents/discord/discord-tools";
import { resolveProfile } from "@app/profile";
import { loadPromptFile } from "@app/prompt";
import { DiscordUserDirectory } from "@modules/discord/application/discord-user-directory";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import { JsonMemoryStore } from "@modules/memory/infrastructure/json-memory-store";
import { QuickJsWatchCheckRunner } from "@modules/scheduling/application/quickjs-watch-check-runner";
import { FileScheduledTaskStore } from "@modules/scheduling/infrastructure/file-scheduled-task-store";
import { MarkdownUserMemoryStore } from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { parseDiscordChannelId } from "@shared/discord-channel-session-key";
import {
  createPiAgentFactory,
  createPiModelRuntime,
  resolveConfiguredModel,
} from "./pi-agent-runtime";
import { TURN_CONTEXT_CUSTOM_TYPE } from "./pi-turn-context";
import {
  buildLinearBranchBeforeEntry,
  serializeSessionEntriesToJsonl,
  type EvalFeedbackCase,
  type LoadedEvalFeedbackCase,
} from "./session-eval-store";
import { createWatchFetchTool } from "./watch-fetch-tool";

type AgentMessage = ContextWithSystemEvent["messages"][number];

class PayloadCaptureShortCircuit extends Error {
  constructor() {
    super("Captured provider payload before network dispatch");
    this.name = "PayloadCaptureShortCircuit";
  }
}

export interface CapturedAgentMessageEntry {
  readonly index: number;
  readonly role: string;
  readonly customType?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly text: string;
  readonly imageCount: number;
}

export interface CapturedLlmRequest {
  readonly index: number;
  readonly label?: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly api: string;
  };
  readonly contextWithSystem: readonly CapturedAgentMessageEntry[];
  readonly transcriptMessages: readonly Message[];
  readonly providerPayload: unknown;
  readonly streamOptions: {
    readonly sessionId?: string;
    readonly cacheRetention?: string;
    readonly reasoning?: string;
    readonly headers?: Readonly<Record<string, string | null>>;
  };
}

export interface CapturedCompleteRequest {
  readonly index: number;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly api: string;
  };
  readonly context: Context;
}

export type ContextLintSeverity = "error" | "warn" | "info";

export interface ContextLintFinding {
  readonly severity: ContextLintSeverity;
  readonly code: string;
  readonly message: string;
}

export interface AnalyzedSystemSection {
  readonly name: string;
  readonly chars: number;
  readonly tokens: number;
}

export interface AnalyzedToolSummary {
  readonly name: string;
  readonly description: string;
  readonly descriptionChars: number;
  readonly schemaChars: number;
  readonly totalChars: number;
  readonly estimatedTokens: number;
}

export interface AnalyzedMessageSummary {
  readonly index: number;
  readonly role: string;
  readonly kind: string;
  readonly customType?: string;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly imageCount: number;
  readonly preview: string;
  readonly text: string;
}

export interface ProviderPayloadView {
  readonly api: string;
  readonly systemInstructionChars: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly messageCount: number;
  readonly messageRoles: readonly string[];
}

export interface ContextAnalysis {
  readonly requestIndex: number;
  readonly label?: string;
  readonly model: CapturedLlmRequest["model"];
  readonly systemPrompt: string;
  readonly systemPromptChars: number;
  readonly systemPromptTokens: number;
  readonly systemSections: readonly AnalyzedSystemSection[];
  readonly tools: readonly AnalyzedToolSummary[];
  readonly toolsTotalChars: number;
  readonly toolsTotalTokens: number;
  readonly messages: readonly AnalyzedMessageSummary[];
  readonly messagesTotalChars: number;
  readonly messagesTotalTokens: number;
  readonly totalChars: number;
  readonly totalEstimatedTokens: number;
  readonly providerView?: ProviderPayloadView;
  readonly findings: readonly ContextLintFinding[];
}

export interface PrefixStabilityReport {
  readonly previousIndex: number;
  readonly currentIndex: number;
  readonly transcript: {
    readonly sharedPrefixChars: number;
    readonly previousTotalChars: number;
    readonly currentTotalChars: number;
    readonly ratio: number;
    readonly firstDiffIndex?: number;
    readonly firstDiffLabel?: string;
  };
  readonly providerPayload?: {
    readonly sharedPrefixChars: number;
    readonly previousTotalChars: number;
    readonly currentTotalChars: number;
    readonly ratio: number;
    readonly firstDiffPath?: string;
  };
}

export interface DryRunHarnessOptions {
  readonly providers?: readonly string[];
  readonly responses?: readonly FauxResponseStep[];
  readonly onCompleteSimple?: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => Promise<AssistantMessage> | AssistantMessage;
  readonly captureProviderPayload?: boolean;
}

export interface ContextEvaluationHarness {
  readonly modelRuntime: ModelRuntime;
  readonly captureExtension: ExtensionFactory;
  readonly requests: readonly CapturedLlmRequest[];
  readonly completeRequests: readonly CapturedCompleteRequest[];
  setNextLabel(label: string | undefined): void;
  setResponses(responses: readonly FauxResponseStep[]): void;
  appendResponses(responses: readonly FauxResponseStep[]): void;
  dispose(): void;
}

export async function createContextEvaluationHarness(
  options: DryRunHarnessOptions = {},
): Promise<ContextEvaluationHarness> {
  const tempRoot = mkdtempSync(join(tmpdir(), "klein-ctx-eval-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempRoot, "auth.json"),
    modelsPath: join(tempRoot, "models.json"),
    modelsStorePath: join(tempRoot, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const providers = options.providers ?? ["opencode-go", "google", "mistral"];
  for (const provider of providers) {
    await modelRuntime.setRuntimeApiKey(provider, "eval-dummy-key");
  }

  const fauxCore = createFauxCore({
    models: [
      {
        id: "eval-faux",
        name: "Eval Faux Model",
        reasoning: false,
        input: ["text", "image"],
      },
    ],
  });
  fauxCore.setResponses([...(options.responses ?? [])]);

  const requests: CapturedLlmRequest[] = [];
  const completeRequests: CapturedCompleteRequest[] = [];
  let latestContextWithSystem: CapturedAgentMessageEntry[] = [];
  let nextLabel: string | undefined;

  const captureExtension: ExtensionFactory = (pi) => {
    pi.on("context_with_system", (event: { messages: AgentMessage[] }) => {
      latestContextWithSystem = event.messages.map((message, index) =>
        summarizeAgentMessage(message, index),
      );
    });
  };

  const origStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  const captureProviderPayload = options.captureProviderPayload ?? true;

  modelRuntime.streamSimple = ((
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream();
    const capturedContextWithSystem = structuredClone(latestContextWithSystem);
    const capturedTranscriptMessages = structuredClone(context.messages);
    const label = nextLabel;
    nextLabel = undefined;

    void (async () => {
      let providerPayload: unknown;
      if (captureProviderPayload && model.provider !== "faux") {
        providerPayload = await captureBuiltProviderPayload(
          origStreamSimple,
          model,
          context,
          streamOptions,
        );
      }

      requests.push({
        index: requests.length,
        ...(label ? { label } : {}),
        model: {
          provider: model.provider,
          id: model.id,
          api: model.api,
        },
        contextWithSystem: capturedContextWithSystem,
        transcriptMessages: capturedTranscriptMessages,
        providerPayload,
        streamOptions: {
          sessionId: streamOptions?.sessionId,
          cacheRetention: streamOptions?.cacheRetention,
          reasoning: streamOptions?.reasoning,
          headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
        },
      });

      if (fauxCore.getPendingResponseCount() === 0) {
        fauxCore.appendResponses([fauxAssistantMessage("OK")]);
      }

      const fauxStream = fauxCore.streamSimple(
        model as unknown as Model<string>,
        context,
        streamOptions,
      );
      try {
        for await (const event of fauxStream) {
          outer.push(event);
          if (event.type === "done" || event.type === "error") {
            outer.end(event.type === "done" ? event.message : event.error);
            return;
          }
        }
        outer.end();
      } catch (error) {
        const fallback = fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        outer.push({ type: "error", reason: "error", error: fallback });
        outer.end(fallback);
      }
    })();

    return outer;
  }) as typeof modelRuntime.streamSimple;

  modelRuntime.completeSimple = (async (
    model: Model<Api>,
    context: Context,
    completeOptions?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> => {
    completeRequests.push({
      index: completeRequests.length,
      model: {
        provider: model.provider,
        id: model.id,
        api: model.api,
      },
      context: structuredClone(context),
    });

    if (options.onCompleteSimple) {
      return options.onCompleteSimple(model, context, completeOptions);
    }

    return fauxAssistantMessage("Mock completion result.");
  }) as typeof modelRuntime.completeSimple;

  return {
    modelRuntime,
    captureExtension,
    requests,
    completeRequests,
    setNextLabel(label) {
      nextLabel = label;
    },
    setResponses(responses) {
      fauxCore.setResponses([...responses]);
    },
    appendResponses(responses) {
      fauxCore.appendResponses([...responses]);
    },
    dispose() {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function captureBuiltProviderPayload(
  origStreamSimple: ModelRuntime["streamSimple"],
  model: Model<Api>,
  context: TranscriptContext,
  streamOptions?: ModelsSimpleStreamOptions,
): Promise<unknown> {
  let capturedPayload: unknown;
  let captured = false;
  const origOnPayload = streamOptions?.onPayload;

  const probeStream = origStreamSimple(model, context, {
    ...streamOptions,
    apiKey: streamOptions?.apiKey ?? "eval-dummy-key",
    maxRetries: 0,
    onPayload: async (payload, payloadModel) => {
      const transformed = origOnPayload ? await origOnPayload(payload, payloadModel) : undefined;
      capturedPayload = cloneJsonPayload(transformed ?? payload);
      captured = true;
      throw new PayloadCaptureShortCircuit();
    },
  });

  for await (const event of probeStream) {
    if (event.type === "error" && !captured) {
      throw new Error(
        `Failed to capture provider payload for ${model.provider}/${model.id}: ${event.error.errorMessage ?? "unknown error"}`,
      );
    }
  }

  return capturedPayload;
}

function cloneJsonPayload(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof AbortSignal !== "undefined" && nested instanceof AbortSignal) {
        return undefined;
      }
      return nested;
    }),
  );
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

export function analyzeCapturedRequest(
  request: CapturedLlmRequest,
  options: {
    readonly ownerFeaturesAllowed?: boolean;
    readonly expectProviderPayload?: boolean;
  } = {},
): ContextAnalysis {
  const systemMessages = request.transcriptMessages.filter(
    (message): message is SystemMessage => message.role === "system",
  );
  const systemPrompt = getCurrentSystemPrompt(request.transcriptMessages);
  const systemSections = extractSystemSections(systemMessages);
  const tools = getCurrentTools(request.transcriptMessages).map(summarizeTool);

  const contextByTranscriptIndex = mapContextMetaToTranscript(
    request.contextWithSystem,
    request.transcriptMessages,
  );

  const messages: AnalyzedMessageSummary[] = [];
  for (const [index, message] of request.transcriptMessages.entries()) {
    if (message.role === "system") continue;
    const text = renderMessageTextForAnalysis(message);
    const imageCount = countMessageImages(message);
    const matchedMeta = contextByTranscriptIndex.get(index);
    const customType = matchedMeta?.customType;
    const kind = classifyMessageKind(message, customType);
    messages.push({
      index,
      role: message.role,
      kind,
      ...(customType ? { customType } : {}),
      chars: text.length,
      estimatedTokens: estimateTextTokens(text) + imageCount * 258,
      imageCount,
      preview: toPreview(text),
      text,
    });
  }

  const systemPromptChars = systemPrompt.length;
  const systemPromptTokens = estimateTextTokens(systemPrompt);
  const toolsTotalChars = tools.reduce((sum, tool) => sum + tool.totalChars, 0);
  const toolsTotalTokens = tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
  const messagesTotalChars = messages.reduce((sum, message) => sum + message.chars, 0);
  const messagesTotalTokens = messages.reduce((sum, message) => sum + message.estimatedTokens, 0);
  const totalChars = systemPromptChars + toolsTotalChars + messagesTotalChars;
  const totalEstimatedTokens = systemPromptTokens + toolsTotalTokens + messagesTotalTokens;

  const providerView = extractProviderPayloadView(request.model.api, request.providerPayload);
  const findings = lintCapturedRequest(request, {
    systemPrompt,
    tools,
    messages,
    providerView,
    ownerFeaturesAllowed: options.ownerFeaturesAllowed,
    expectProviderPayload: options.expectProviderPayload,
  });

  return {
    requestIndex: request.index,
    ...(request.label ? { label: request.label } : {}),
    model: request.model,
    systemPrompt,
    systemPromptChars,
    systemPromptTokens,
    systemSections,
    tools,
    toolsTotalChars,
    toolsTotalTokens,
    messages,
    messagesTotalChars,
    messagesTotalTokens,
    totalChars,
    totalEstimatedTokens,
    ...(providerView ? { providerView } : {}),
    findings,
  };
}

export function comparePrefixStability(
  previous: CapturedLlmRequest,
  current: CapturedLlmRequest,
): PrefixStabilityReport {
  const prevSerializedMessages = previous.transcriptMessages.map((message) =>
    JSON.stringify(stripTimestamps(message)),
  );
  const currSerializedMessages = current.transcriptMessages.map((message) =>
    JSON.stringify(stripTimestamps(message)),
  );

  let firstDiffIndex: number | undefined;
  const maxSharedMessages = Math.min(prevSerializedMessages.length, currSerializedMessages.length);
  for (let i = 0; i < maxSharedMessages; i += 1) {
    if (prevSerializedMessages[i] !== currSerializedMessages[i]) {
      firstDiffIndex = i;
      break;
    }
  }
  if (
    firstDiffIndex === undefined &&
    prevSerializedMessages.length !== currSerializedMessages.length
  ) {
    firstDiffIndex = maxSharedMessages;
  }

  const prevFull = prevSerializedMessages.join("\n");
  const currFull = currSerializedMessages.join("\n");
  const sharedTranscriptChars = commonPrefixLength(prevFull, currFull);
  const firstDiffMessage =
    firstDiffIndex !== undefined ? current.transcriptMessages[firstDiffIndex] : undefined;

  let providerStability: PrefixStabilityReport["providerPayload"];
  if (previous.providerPayload !== undefined && current.providerPayload !== undefined) {
    const prevNormalized = normalizeProviderPayloadForCache(
      previous.model.api,
      previous.providerPayload,
    );
    const currNormalized = normalizeProviderPayloadForCache(
      current.model.api,
      current.providerPayload,
    );
    const prevJson = JSON.stringify(prevNormalized);
    const currJson = JSON.stringify(currNormalized);
    const sharedChars = commonPrefixLength(prevJson, currJson);
    providerStability = {
      sharedPrefixChars: sharedChars,
      previousTotalChars: prevJson.length,
      currentTotalChars: currJson.length,
      ratio: prevJson.length > 0 ? sharedChars / prevJson.length : 1,
      firstDiffPath: findFirstJsonDiffPath(prevNormalized, currNormalized),
    };
  }

  return {
    previousIndex: previous.index,
    currentIndex: current.index,
    transcript: {
      sharedPrefixChars: sharedTranscriptChars,
      previousTotalChars: prevFull.length,
      currentTotalChars: currFull.length,
      ratio: prevFull.length > 0 ? sharedTranscriptChars / prevFull.length : 1,
      ...(firstDiffIndex !== undefined ? { firstDiffIndex } : {}),
      ...(firstDiffMessage
        ? {
            firstDiffLabel: `${firstDiffMessage.role}:${classifyMessageKind(firstDiffMessage)}`,
          }
        : {}),
    },
    ...(providerStability ? { providerPayload: providerStability } : {}),
  };
}

export function lintCapturedRequest(
  request: CapturedLlmRequest,
  context: {
    readonly systemPrompt: string;
    readonly tools: readonly AnalyzedToolSummary[];
    readonly messages: readonly AnalyzedMessageSummary[];
    readonly providerView?: ProviderPayloadView;
    readonly ownerFeaturesAllowed?: boolean;
    readonly expectProviderPayload?: boolean;
  },
): ContextLintFinding[] {
  const findings: ContextLintFinding[] = [];

  if (context.systemPrompt.trim().length === 0) {
    findings.push({
      severity: "error",
      code: "empty-system-prompt",
      message: "System prompt is empty in the final transcript.",
    });
  }

  const turnContextMessages = context.messages.filter(
    (message) => message.customType === TURN_CONTEXT_CUSTOM_TYPE || message.kind === "turn-context",
  );
  if (turnContextMessages.length > 1) {
    findings.push({
      severity: "error",
      code: "duplicate-turn-context",
      message: `Expected at most 1 turn-context message, found ${turnContextMessages.length}.`,
    });
  }

  if (turnContextMessages.length === 1) {
    const turnContext = turnContextMessages[0]!;
    const lastEventUser = context.messages.findLast(
      (message) => message.role === "user" && message.kind === "event",
    );
    if (lastEventUser && turnContext.index > lastEventUser.index) {
      findings.push({
        severity: "error",
        code: "turn-context-after-last-user",
        message: `Turn context (index ${turnContext.index}) appears after the latest user event (index ${lastEventUser.index}).`,
      });
    }
  }

  const hasDiscordSend = context.tools.some((tool) => tool.name === "discord_send");
  if (hasDiscordSend) {
    const lastUserIndex = context.messages.findLastIndex((message) => message.role === "user");
    const completedAssistantAfterUser = context.messages.filter(
      (message) => message.role === "assistant" && message.index < lastUserIndex,
    );
    for (const assistant of completedAssistantAfterUser) {
      const rawMessage = request.transcriptMessages[assistant.index];
      if (!rawMessage || rawMessage.role !== "assistant") continue;
      const textBlocks = rawMessage.content.filter((block) => block.type === "text");
      const hasToolCall = rawMessage.content.some((block) => block.type === "toolCall");
      if (!hasToolCall) {
        const text = textBlocks.map((block) => block.text).join("\n");
        if (
          text !== "Sent a message to Discord." &&
          text !== "I didn't use discord_send, so I stayed silent."
        ) {
          findings.push({
            severity: "warn",
            code: "unnormalized-completed-assistant-text",
            message: `Completed assistant message at index ${assistant.index} still contains raw text instead of normalized outcome.`,
          });
        }
      }
    }
  }

  if (context.ownerFeaturesAllowed === false) {
    const ownerTools = context.tools.filter((tool) => tool.name.startsWith("owner_memory_"));
    if (ownerTools.length > 0) {
      findings.push({
        severity: "error",
        code: "owner-tool-exposed-to-public",
        message: `Owner-only tools exposed when ownerFeaturesAllowed=false: ${ownerTools.map((tool) => tool.name).join(", ")}.`,
      });
    }
    const leakedOwnerMemory = context.messages.some((message) =>
      message.text.includes("<owner-memory>"),
    );
    if (leakedOwnerMemory) {
      findings.push({
        severity: "error",
        code: "owner-memory-exposed-to-public",
        message: "<owner-memory> appeared in final messages when ownerFeaturesAllowed=false.",
      });
    }
  }

  const xmlTagsToCheck = [
    "event-metadata",
    "image-analysis",
    "previous-conversation-context",
    "owner-memory",
    "user-memory",
    "guild-memory",
    "channel-rule",
  ];
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    for (const tag of xmlTagsToCheck) {
      const openCount = countMatches(message.text, new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gu"));
      const closeCount = countMatches(message.text, new RegExp(`</${tag}>`, "gu"));
      if (openCount !== closeCount) {
        findings.push({
          severity: "warn",
          code: "unbalanced-xml-tag",
          message: `Message at index ${message.index} has unbalanced <${tag}> tags (open=${openCount}, close=${closeCount}).`,
        });
      }
    }
  }

  if (context.expectProviderPayload && request.providerPayload === undefined) {
    findings.push({
      severity: "error",
      code: "missing-provider-payload",
      message: "Expected captured providerPayload, but it was undefined.",
    });
  }

  if (context.providerView) {
    if (context.providerView.systemInstructionChars === 0) {
      findings.push({
        severity: "error",
        code: "provider-missing-system",
        message: `Provider payload (${context.providerView.api}) has no system instruction.`,
      });
    }
    if (context.tools.length > 0 && context.providerView.toolCount !== context.tools.length) {
      findings.push({
        severity: "warn",
        code: "provider-tool-count-mismatch",
        message: `Transcript has ${context.tools.length} tools, but provider payload declares ${context.providerView.toolCount}.`,
      });
    }
  }

  return findings;
}

export function renderContextEvaluationMarkdown(
  requests: readonly CapturedLlmRequest[],
  options: {
    readonly title?: string;
    readonly ownerFeaturesAllowed?: boolean;
    readonly includeFullSystemPrompt?: boolean;
    readonly includeToolDetails?: boolean;
    readonly includeProviderPayloadSample?: boolean;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${options.title ?? "Context Evaluation Report"}`);
  lines.push("");

  const analyses = requests.map((request) =>
    analyzeCapturedRequest(request, {
      ownerFeaturesAllowed: options.ownerFeaturesAllowed,
    }),
  );

  lines.push("## Overview");
  lines.push("");
  lines.push(
    "| # | Label | Model | System Tokens | Tools (count / tokens) | Messages (count / tokens) | Total Est. Tokens | Findings |",
  );
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const analysis of analyses) {
    lines.push(
      `| ${analysis.requestIndex} | ${escapeTableCell(analysis.label ?? "-")} | ${analysis.model.provider}/${analysis.model.id} | ${analysis.systemPromptTokens} | ${analysis.tools.length} / ${analysis.toolsTotalTokens} | ${analysis.messages.length} / ${analysis.messagesTotalTokens} | ${analysis.totalEstimatedTokens} | ${analysis.findings.length} |`,
    );
  }
  lines.push("");

  if (requests.length >= 2) {
    lines.push("## Prefix Cache Stability");
    lines.push("");
    lines.push(
      "| Transition | Transcript Prefix Match | Provider Payload Prefix Match | First Diff |",
    );
    lines.push("| --- | ---: | ---: | --- |");
    for (let i = 1; i < requests.length; i += 1) {
      const stability = comparePrefixStability(requests[i - 1]!, requests[i]!);
      const tRatio = `${(stability.transcript.ratio * 100).toFixed(1)}% (${stability.transcript.sharedPrefixChars}/${stability.transcript.previousTotalChars})`;
      const pRatio = stability.providerPayload
        ? `${(stability.providerPayload.ratio * 100).toFixed(1)}% (${stability.providerPayload.sharedPrefixChars}/${stability.providerPayload.previousTotalChars})`
        : "-";
      const diff =
        stability.providerPayload?.firstDiffPath ??
        (stability.transcript.firstDiffIndex !== undefined
          ? `messages[${stability.transcript.firstDiffIndex}] (${stability.transcript.firstDiffLabel ?? ""})`
          : "none");
      lines.push(`| #${i - 1} -> #${i} | ${tRatio} | ${pRatio} | ${escapeTableCell(diff)} |`);
    }
    lines.push("");
  }

  for (const [idx, analysis] of analyses.entries()) {
    const request = requests[idx]!;
    lines.push(
      `## Request #${analysis.requestIndex}${analysis.label ? ` (${analysis.label})` : ""}`,
    );
    lines.push("");
    lines.push(
      `- Model: \`${analysis.model.provider}/${analysis.model.id}\` (\`${analysis.model.api}\`)`,
    );
    lines.push(
      `- Tokens (est.): system=${analysis.systemPromptTokens}, tools=${analysis.toolsTotalTokens}, messages=${analysis.messagesTotalTokens}, total=${analysis.totalEstimatedTokens}`,
    );
    if (analysis.providerView) {
      lines.push(
        `- Provider Payload: messages=${analysis.providerView.messageCount} [${analysis.providerView.messageRoles.join(" -> ")}], tools=${analysis.providerView.toolCount}, systemChars=${analysis.providerView.systemInstructionChars}`,
      );
    }
    lines.push("");

    if (analysis.findings.length > 0) {
      lines.push("### Findings");
      lines.push("");
      for (const finding of analysis.findings) {
        lines.push(`- [${finding.severity.toUpperCase()}] \`${finding.code}\`: ${finding.message}`);
      }
      lines.push("");
    }

    if (options.includeFullSystemPrompt !== false) {
      lines.push("### System Prompt");
      lines.push("");
      if (analysis.systemSections.length > 0) {
        lines.push("Sections:");
        for (const section of analysis.systemSections) {
          lines.push(`- \`${section.name}\`: ${section.chars} chars (~${section.tokens} tokens)`);
        }
        lines.push("");
      }
      lines.push("````markdown");
      lines.push(analysis.systemPrompt);
      lines.push("````");
      lines.push("");
    }

    if (options.includeToolDetails !== false) {
      lines.push("### Declared Tools");
      lines.push("");
      lines.push("| Tool | Desc Chars | Schema Chars | Est. Tokens | Description |");
      lines.push("| --- | ---: | ---: | ---: | --- |");
      for (const tool of analysis.tools) {
        lines.push(
          `| \`${tool.name}\` | ${tool.descriptionChars} | ${tool.schemaChars} | ${tool.estimatedTokens} | ${escapeTableCell(toPreview(tool.description, 100))} |`,
        );
      }
      lines.push("");
    }

    lines.push("### Messages Sequence (Final Transcript Order)");
    lines.push("");
    for (const message of analysis.messages) {
      const tag = message.customType ? `${message.kind} (${message.customType})` : message.kind;
      lines.push(
        `#### [${message.index}] role=\`${message.role}\` kind=\`${tag}\` (${message.chars} chars, ~${message.estimatedTokens} tokens${message.imageCount > 0 ? `, images=${message.imageCount}` : ""})`,
      );
      lines.push("");
      lines.push("````text");
      lines.push(message.text);
      lines.push("````");
      lines.push("");
    }

    if (options.includeProviderPayloadSample && request.providerPayload !== undefined) {
      lines.push("### Provider Payload (JSON)");
      lines.push("");
      lines.push("````json");
      lines.push(JSON.stringify(request.providerPayload, null, 2));
      lines.push("````");
      lines.push("");
    }
  }

  return lines.join("\n");
}

export interface ContextJudgeFeedbackContext {
  readonly caseId: string;
  readonly reaction: EvalFeedbackCase["reaction"];
  readonly recordedResponse: EvalFeedbackCase["recordedResponse"];
}

export function buildContextJudgePrompt(
  reportMarkdown: string,
  feedbackContext?: ContextJudgeFeedbackContext,
): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    "You are an expert LLM context engineer auditing the final serialized API request payloads of a Discord communication agent.",
    "Evaluate strictly what is present in the report: system prompt, tool definitions, custom messages, event metadata, and message ordering.",
    "Respond in Japanese using valid JSON matching the requested schema.",
  ].join("\n");

  const feedbackSection = feedbackContext
    ? [
        "",
        "記録されたネガティブフィードバックケース:",
        `- Case ID: ${feedbackContext.caseId}`,
        `- Reaction: ${feedbackContext.reaction.emoji} by ${feedbackContext.reaction.userId} (isOwner=${feedbackContext.reaction.isOwner}, occurredAt=${feedbackContext.reaction.occurredAt})`,
        `- Recorded Discord Response: ${JSON.stringify(feedbackContext.recordedResponse.content)}`,
        ...(feedbackContext.recordedResponse.assistantTextBeforeCall
          ? [
              `- Assistant Reasoning Text Before Call: ${JSON.stringify(feedbackContext.recordedResponse.assistantTextBeforeCall)}`,
            ]
          : []),
        "このコンテキスト状態でなぜ上記の応答が不適切・不十分と評価された可能性があるかも、issuesに含めて分析してください。",
      ]
    : [];

  const userPrompt = [
    "以下の最終送信コンテキスト評価レポートを精査し、プロンプト・ツール・イベント・カスタムメッセージの順番と品質を評価してください。",
    "",
    "評価観点:",
    "1. ordering_and_boundaries: システム指示、記憶(<user-memory>/<guild-memory>/<owner-memory>/<channel-rule>)、ハンドオフ、画像解析、イベントメタデータ、完了ターン要約の順序がモデルにとって明確か。",
    "2. instruction_consistency: SOUL.md・システムルール・スキル・ツール説明・チャンネルルールの間で矛盾・重複・曖昧さがないか。",
    "3. tool_clarity_and_budget: ツール一覧やJSON Schemaの重複・紛らわしさ・トークン効率の問題がないか。",
    "4. untrusted_data_isolation: Discord発言や画像解析結果などの外部非信頼データとシステム指示の境界が堅牢か。",
    '5. turn_target_clarity: 複数ユーザー発言・ステアリング・過去の"Sent a message to Discord."置換が混在したときに「今誰に何を返すべきか」を誤認しないか。',
    ...feedbackSection,
    "",
    "出力JSONスキーマ:",
    "{",
    '  "scores": { "ordering_and_boundaries": 1-5, "instruction_consistency": 1-5, "tool_clarity_and_budget": 1-5, "untrusted_data_isolation": 1-5, "turn_target_clarity": 1-5 },',
    '  "strengths": ["..."],',
    '  "issues": [{ "severity": "high|medium|low", "area": "...", "description": "...", "recommendation": "..." }]',
    "}",
    "",
    "--- REPORT ---",
    reportMarkdown,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export type SessionReplayMode = "turn-start" | "pre-message";

export interface ExtractedSessionTurn {
  readonly turnIndex: number;
  readonly userEntryId: string;
  readonly timestamp: string;
  readonly userText: string;
  readonly images: readonly ImageContent[];
  readonly turnContextEntryId?: string;
  readonly hasTurnContext: boolean;
  readonly firstAssistantEntryId?: string;
  readonly discordSendAssistantEntryId?: string;
  readonly assistantEntryId?: string;
  readonly assistantText?: string;
  readonly discordSendContents: readonly string[];
}

export interface EvaluateSessionEntriesOptions {
  readonly entries: readonly FileEntry[];
  readonly profile?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
  readonly ownerFeaturesAllowed?: boolean;
  readonly ownerUserId?: string;
  readonly skillsDirectory?: string;
  readonly systemPromptFile?: string;
  readonly systemPromptOverride?: string;
  readonly sessionKey?: string;
  readonly mode?: SessionReplayMode;
  readonly turnIndex?: number;
  readonly allTurns?: boolean;
  readonly maxTurns?: number;
  readonly preSliced?: boolean;
  readonly responses?: readonly FauxResponseStep[];
  readonly liveReplay?: boolean;
  readonly runtimeAgentDir?: string;
  readonly labelPrefix?: string;
}

export interface EvaluatedTurnOutput {
  readonly turnIndex?: number;
  readonly mode: SessionReplayMode;
  readonly label: string;
  readonly requests: readonly CapturedLlmRequest[];
  readonly sentMessages: readonly string[];
  readonly finalAssistantText?: string;
}

export interface EvaluateSessionResult {
  readonly sessionId: string;
  readonly turns: readonly ExtractedSessionTurn[];
  readonly evaluatedTurns: readonly EvaluatedTurnOutput[];
  readonly requests: readonly CapturedLlmRequest[];
}

export function extractSessionTurns(entries: readonly FileEntry[]): ExtractedSessionTurn[] {
  if (entries.length === 0) return [];
  const manager = SessionManager.inMemory(process.cwd(), undefined, [...entries]);
  const branch = manager.getBranch();

  const userIndices: number[] = [];
  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i]!;
    if (entry.type === "message" && entry.message.role === "user") {
      userIndices.push(i);
    }
  }

  return userIndices.map((userIndex, turnIndex) => {
    const userEntry = branch[userIndex]!;
    const prevBoundary = turnIndex > 0 ? userIndices[turnIndex - 1]! : -1;
    const nextBoundary =
      turnIndex + 1 < userIndices.length ? userIndices[turnIndex + 1]! : branch.length;

    let turnContextEntryId: string | undefined;
    for (let i = userIndex - 1; i > prevBoundary; i -= 1) {
      const candidate = branch[i]!;
      if (candidate.type === "custom" && candidate.customType === TURN_CONTEXT_CUSTOM_TYPE) {
        turnContextEntryId = candidate.id;
        break;
      }
    }

    let firstAssistantEntryId: string | undefined;
    let discordSendAssistantEntryId: string | undefined;
    let assistantEntryId: string | undefined;
    const assistantTextParts: string[] = [];
    const discordSendContents: string[] = [];

    for (let i = userIndex + 1; i < nextBoundary; i += 1) {
      const candidate = branch[i]!;
      if (candidate.type !== "message" || candidate.message.role !== "assistant") continue;
      firstAssistantEntryId ??= candidate.id;
      assistantEntryId = candidate.id;
      for (const block of candidate.message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          assistantTextParts.push(block.text.trim());
        } else if (
          block.type === "toolCall" &&
          block.name === "discord_send" &&
          typeof block.arguments?.content === "string"
        ) {
          discordSendAssistantEntryId ??= candidate.id;
          discordSendContents.push(block.arguments.content);
        }
      }
    }

    const { userText, images } =
      userEntry.type === "message" && userEntry.message.role === "user"
        ? extractUserMessageParts(userEntry.message.content)
        : { userText: "", images: [] };

    return {
      turnIndex,
      userEntryId: userEntry.id,
      timestamp: userEntry.timestamp,
      userText,
      images,
      ...(turnContextEntryId ? { turnContextEntryId } : {}),
      hasTurnContext: turnContextEntryId !== undefined,
      ...(firstAssistantEntryId ? { firstAssistantEntryId } : {}),
      ...(discordSendAssistantEntryId ? { discordSendAssistantEntryId } : {}),
      ...(assistantEntryId ? { assistantEntryId } : {}),
      ...(assistantTextParts.length > 0 ? { assistantText: assistantTextParts.join("\n") } : {}),
      discordSendContents,
    };
  });
}

export async function evaluateSessionEntries(
  options: EvaluateSessionEntriesOptions,
): Promise<EvaluateSessionResult> {
  const header = options.entries.find((entry) => entry.type === "session");
  if (!header || header.type !== "session") {
    throw new Error("Session entries are missing a session header");
  }

  const turns = extractSessionTurns(options.entries);
  const mode: SessionReplayMode = options.mode ?? "turn-start";
  const profileConfig = resolveProfile(options.profile ?? "klein");
  const systemPrompt =
    options.systemPromptOverride ??
    (await loadPromptFile(options.systemPromptFile ?? profileConfig.systemPromptFile));
  const skillsDirectory = options.skillsDirectory ?? profileConfig.skillsDirectory;

  const sessionProjection = SessionManager.inMemory(process.cwd(), undefined, [
    ...options.entries,
  ]).buildSessionContext();
  const candidateProvider = options.provider ?? sessionProjection.model?.provider ?? "opencode-go";
  const candidateModel = options.model ?? sessionProjection.model?.modelId ?? "deepseek-v4.1-flash";

  const tempRoot = await mkdtemp(join(tmpdir(), "klein-session-eval-"));
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

  let runtimeCapture:
    | ContextEvaluationHarness
    | {
        readonly modelRuntime: ModelRuntime;
        readonly captureExtension: ExtensionFactory;
        readonly requests: CapturedLlmRequest[];
        setNextLabel(label: string | undefined): void;
        dispose(): void;
      };

  if (options.liveReplay) {
    const runtime = await createPiModelRuntime(resolve(options.runtimeAgentDir ?? ".runtime/pi"));
    runtimeCapture = attachLiveRequestCapture(runtime);
  } else {
    const providers = [...new Set(["opencode-go", "google", "mistral", candidateProvider])];
    runtimeCapture = await createContextEvaluationHarness({
      providers,
      responses: options.responses,
      onCompleteSimple: async () =>
        fauxAssistantMessage("Dry-run image analysis result for evaluation."),
    });
  }

  try {
    const resolvedModel = options.liveReplay
      ? resolveConfiguredModel(candidateProvider, candidateModel, runtimeCapture.modelRuntime)
      : resolveSafeEvalModel(candidateProvider, candidateModel, runtimeCapture.modelRuntime);

    const sessionKey = options.sessionKey ?? "eval-session";
    const ownerFeaturesAllowed = options.ownerFeaturesAllowed ?? sessionKey.includes(":owner:");
    const ownerUserId = options.ownerUserId ?? "owner-1";
    const channelId = parseDiscordChannelId(sessionKey) ?? "ch-eval";
    const labelPrefix = options.labelPrefix ?? header.id.slice(0, 8);

    interface SlicePlan {
      readonly turn?: ExtractedSessionTurn;
      readonly label: string;
      readonly fileEntries: readonly FileEntry[];
    }

    const plans: SlicePlan[] = [];
    if (options.preSliced && mode === "pre-message") {
      const leafId = findBranchLeafId(options.entries);
      if (!leafId) {
        throw new Error("Pre-sliced session has no entries after the session header");
      }
      const { fileEntries } = buildLinearBranchBeforeEntry(options.entries, leafId, {
        inclusive: true,
        dropSystemMessages: false,
      });
      plans.push({
        turn: turns.at(-1),
        label: `${labelPrefix}:pre-message`,
        fileEntries,
      });
    } else {
      if (turns.length === 0) {
        return {
          sessionId: header.id,
          turns: [],
          evaluatedTurns: [],
          requests: [],
        };
      }

      let selectedTurns: ExtractedSessionTurn[];
      if (options.allTurns) {
        selectedTurns =
          options.maxTurns !== undefined && options.maxTurns > 0
            ? turns.slice(-options.maxTurns)
            : turns;
      } else {
        const rawIndex = options.turnIndex ?? turns.length - 1;
        const normalizedIndex = rawIndex < 0 ? turns.length + rawIndex : rawIndex;
        const target = turns[normalizedIndex];
        if (!target) {
          throw new Error(
            `Turn index ${rawIndex} is out of range for session with ${turns.length} turns`,
          );
        }
        selectedTurns = [target];
      }

      for (const turn of selectedTurns) {
        if (mode === "turn-start") {
          const { fileEntries } = buildLinearBranchBeforeEntry(options.entries, turn.userEntryId, {
            inclusive: false,
            dropSystemMessages: true,
          });
          plans.push({
            turn,
            label: `${labelPrefix}:turn-${turn.turnIndex}`,
            fileEntries,
          });
        } else {
          const targetAssistantId = turn.discordSendAssistantEntryId ?? turn.firstAssistantEntryId;
          const { fileEntries } = targetAssistantId
            ? buildLinearBranchBeforeEntry(options.entries, targetAssistantId, {
                inclusive: false,
                dropSystemMessages: false,
              })
            : buildLinearBranchBeforeEntry(options.entries, turn.userEntryId, {
                inclusive: true,
                dropSystemMessages: false,
              });
          plans.push({
            turn,
            label: `${labelPrefix}:turn-${turn.turnIndex}:pre-message`,
            fileEntries,
          });
        }
      }
    }

    const silentLogger = pino({ level: "silent" });
    const evaluatedTurns: EvaluatedTurnOutput[] = [];
    const allRequests: CapturedLlmRequest[] = [];

    for (const [sliceIndex, plan] of plans.entries()) {
      const sliceRoot = join(tempRoot, `slice-${sliceIndex}`);
      const agentDir = join(sliceRoot, "pi");
      const sessionDir = join(agentDir, "sessions", encodeURIComponent(sessionKey));
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ cacheWarming: "off" }),
        "utf8",
      );

      const normalizedEntries = normalizeSessionCwd(plan.fileEntries, process.cwd());
      const safeTimestamp = header.timestamp.replace(/[:.]/g, "-");
      const sessionFilePath = join(sessionDir, `${safeTimestamp}_${header.id}.jsonl`);
      await writeFile(sessionFilePath, serializeSessionEntriesToJsonl(normalizedEntries), "utf8");

      const sentMessages: string[] = [];
      const channelApi: Pick<
        DiscordChannelApi,
        "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
      > = {
        async readMessage(target) {
          return createFallbackSampleDiscordMessage(target.channelId, target.messageId);
        },
        async sendMessage(_channelId, content) {
          sentMessages.push(content);
          return [`eval-sent-${sentMessages.length}`];
        },
        async sendTyping() {},
        async sendAudio() {},
      };

      const watchToolCatalog = { tools: [createWatchFetchTool({ agentDir })] };
      const watchCheckRunner = new QuickJsWatchCheckRunner({ tools: watchToolCatalog.tools });
      const scheduledTaskStore = new FileScheduledTaskStore(join(sliceRoot, "schedules"));
      const ownerMemoryStore = new OwnerMemoryStore(
        new JsonMemoryStore(join(sliceRoot, "owner-memory", "MEMORY.json")),
      );
      const userMemoryStore = new MarkdownUserMemoryStore(join(sliceRoot, "user-memory"));
      const discordUserDirectory = new DiscordUserDirectory(
        join(sliceRoot, "discord-users.json"),
        silentLogger,
      );

      let createdSession:
        | Parameters<NonNullable<Parameters<typeof createPiAgentFactory>[0]["onSessionCreated"]>>[0]
        | undefined;

      const factory = createPiAgentFactory({
        agentDir,
        llm: {
          provider: resolvedModel.provider,
          model: resolvedModel.id,
          thinkingLevel: options.thinkingLevel ?? "low",
        },
        skillsDirectory,
        logger: silentLogger,
        modelRuntime: runtimeCapture.modelRuntime,
        sessionMode: "resume",
        watchToolCatalog,
        extraExtensions: [runtimeCapture.captureExtension],
        onSessionCreated: (session) => {
          createdSession = session;
        },
      });

      const agent = await DiscordAgent.create(factory, channelId, systemPrompt, {
        sessionKey,
        ownerFeaturesAllowed,
        ownerUserId,
        tools: (analyzeImage) =>
          createDiscordAgentTools(
            {
              channelApi,
              channelId,
              ownerFeaturesAllowed,
              ownerUserId,
              scheduledTaskStore,
              watchCheckRunner,
              ownerMemoryStore,
              userMemoryStore,
              discordUserDirectory,
            },
            analyzeImage,
          ),
      });

      const startRequestIdx = runtimeCapture.requests.length;
      runtimeCapture.setNextLabel(plan.label);

      try {
        if (!createdSession) {
          throw new Error("Failed to capture underlying Pi AgentSession");
        }

        if (mode === "turn-start") {
          const turn = plan.turn!;
          await createdSession.prompt(turn.userText, {
            images: turn.images.length > 0 ? [...turn.images] : undefined,
            source: "rpc",
          });
        } else {
          if (createdSession.agent.state.messages.length === 0) {
            throw new Error("Cannot evaluate pre-message snapshot with empty messages");
          }
          if (createdSession.agent.state.messages.at(-1)?.role === "assistant") {
            throw new Error(
              "Cannot evaluate pre-message snapshot when the last message is already an assistant message",
            );
          }
          if (!createdSession.agent.state.messages.some((message) => message.role === "system")) {
            const initialSystem = createInitialSystemMessage(
              createdSession.systemPrompt,
              createdSession.agent.state.tools.map(toToolDeclaration),
            );
            if (initialSystem) {
              createdSession.agent.state.messages = [
                initialSystem,
                ...createdSession.agent.state.messages,
              ];
            }
          }
          await createdSession.agent.continue();
        }

        const sliceRequests = runtimeCapture.requests.slice(startRequestIdx).map((req, offset) => ({
          ...req,
          index: allRequests.length + offset,
          label: req.label ?? `${plan.label}#${offset}`,
        }));
        allRequests.push(...sliceRequests);

        const lastMessage = createdSession.messages.at(-1);
        const finalAssistantText =
          lastMessage && lastMessage.role === "assistant"
            ? extractAssistantText(lastMessage)
            : undefined;

        evaluatedTurns.push({
          ...(plan.turn ? { turnIndex: plan.turn.turnIndex } : {}),
          mode,
          label: plan.label,
          requests: sliceRequests,
          sentMessages,
          ...(finalAssistantText ? { finalAssistantText } : {}),
        });
      } finally {
        agent.dispose();
      }
    }

    return {
      sessionId: header.id,
      turns,
      evaluatedTurns,
      requests: allRequests,
    };
  } finally {
    runtimeCapture.dispose();
    if (previousAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function evaluateEvalFeedbackCase(
  loadedCase: LoadedEvalFeedbackCase,
  options: Omit<
    EvaluateSessionEntriesOptions,
    "entries" | "preSliced" | "turnIndex" | "allTurns"
  > = {},
): Promise<EvaluateSessionResult & { readonly mode: SessionReplayMode }> {
  const lastMessageRole = findLastMessageRole(loadedCase.entries);
  const inferredMode: SessionReplayMode =
    options.mode ??
    (loadedCase.caseMeta.slice.turnStartEntryId && lastMessageRole === "user"
      ? "turn-start"
      : "pre-message");

  const result = await evaluateSessionEntries({
    ...options,
    entries: loadedCase.entries,
    mode: inferredMode,
    preSliced: inferredMode === "pre-message",
    ownerFeaturesAllowed:
      options.ownerFeaturesAllowed ?? loadedCase.caseMeta.sourceSession.ownerFeaturesAllowed,
    sessionKey: options.sessionKey ?? loadedCase.caseMeta.sourceSession.sessionKey,
    labelPrefix: options.labelPrefix ?? `case:${loadedCase.caseMeta.caseId}`,
  });

  return {
    ...result,
    mode: inferredMode,
  };
}

function attachLiveRequestCapture(modelRuntime: ModelRuntime): {
  readonly modelRuntime: ModelRuntime;
  readonly captureExtension: ExtensionFactory;
  readonly requests: CapturedLlmRequest[];
  setNextLabel(label: string | undefined): void;
  dispose(): void;
} {
  const requests: CapturedLlmRequest[] = [];
  let latestContextWithSystem: CapturedAgentMessageEntry[] = [];
  let nextLabel: string | undefined;

  const captureExtension: ExtensionFactory = (pi) => {
    pi.on("context_with_system", (event: { messages: AgentMessage[] }) => {
      latestContextWithSystem = event.messages.map((message, index) =>
        summarizeAgentMessage(message, index),
      );
    });
  };

  const origStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const capturedContextWithSystem = structuredClone(latestContextWithSystem);
    const capturedTranscriptMessages = structuredClone(context.messages);
    const label = nextLabel;
    nextLabel = undefined;
    const origOnPayload = streamOptions?.onPayload;

    let recorded = false;
    const record = (providerPayload: unknown): void => {
      if (recorded) return;
      recorded = true;
      requests.push({
        index: requests.length,
        ...(label ? { label } : {}),
        model: {
          provider: model.provider,
          id: model.id,
          api: model.api,
        },
        contextWithSystem: capturedContextWithSystem,
        transcriptMessages: capturedTranscriptMessages,
        providerPayload,
        streamOptions: {
          sessionId: streamOptions?.sessionId,
          cacheRetention: streamOptions?.cacheRetention,
          reasoning: streamOptions?.reasoning,
          headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
        },
      });
    };

    const stream = origStreamSimple(model, context, {
      ...streamOptions,
      onPayload: async (payload, payloadModel) => {
        const transformed = origOnPayload ? await origOnPayload(payload, payloadModel) : undefined;
        record(cloneJsonPayload(transformed ?? payload));
        return transformed;
      },
    });
    void stream.result().then(
      () => record(undefined),
      () => record(undefined),
    );
    return stream;
  }) as typeof modelRuntime.streamSimple;

  return {
    modelRuntime,
    captureExtension,
    requests,
    setNextLabel(label) {
      nextLabel = label;
    },
    dispose() {},
  };
}

function resolveSafeEvalModel(
  provider: string,
  modelId: string,
  runtime: ModelRuntime,
): Model<Api> {
  try {
    return resolveConfiguredModel(provider, modelId, runtime);
  } catch {
    if (provider === "google") {
      return resolveConfiguredModel("google", "gemini-2.5-flash", runtime);
    }
    if (provider === "mistral") {
      return resolveConfiguredModel("mistral", "deepseek-v4-1-flash-1017", runtime);
    }
    return resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash", runtime);
  }
}

function extractUserMessageParts(content: unknown): {
  readonly userText: string;
  readonly images: readonly ImageContent[];
} {
  if (typeof content === "string") {
    return { userText: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { userText: "", images: [] };
  }

  const textParts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (
      block.type === "image" &&
      "data" in block &&
      typeof block.data === "string" &&
      "mimeType" in block &&
      typeof block.mimeType === "string"
    ) {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    }
  }
  return { userText: textParts.join("\n"), images };
}

function extractAssistantText(message: AssistantMessage): string | undefined {
  const parts = message.content
    .filter((block) => block.type === "text" && block.text.trim().length > 0)
    .map((block) => (block.type === "text" ? block.text.trim() : ""));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeSessionCwd(entries: readonly FileEntry[], cwd: string): FileEntry[] {
  return entries.map((entry) => (entry.type === "session" ? { ...entry, cwd } : entry));
}

function findBranchLeafId(entries: readonly FileEntry[]): string | undefined {
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  if (sessionEntries.length === 0) return undefined;
  const manager = SessionManager.inMemory(process.cwd(), undefined, [...entries]);
  return manager.getLeafId() ?? sessionEntries.at(-1)?.id;
}

function findLastMessageRole(entries: readonly FileEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "message") return entry.message.role;
  }
  return undefined;
}

function createFallbackSampleDiscordMessage(channelId: string, messageId: string): DiscordMessage {
  return {
    id: messageId,
    channelId,
    guildId: "guild-eval",
    channelName: "eval",
    occurredAt: "2026-10-14T09:30:00.000Z",
    author: {
      id: "user-eval",
      username: "user",
      displayName: "User",
      bot: false,
    },
    content: "Placeholder message fetched during offline session evaluation.",
    images: [],
  };
}

function summarizeAgentMessage(message: AgentMessage, index: number): CapturedAgentMessageEntry {
  const role = message.role;
  const customType =
    "customType" in message && typeof message.customType === "string"
      ? message.customType
      : undefined;
  const toolName =
    "toolName" in message && typeof message.toolName === "string" ? message.toolName : undefined;
  const isError =
    "isError" in message && typeof message.isError === "boolean" ? message.isError : undefined;

  let text = "";
  let imageCount = 0;

  if ("content" in message) {
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "image") {
          imageCount += 1;
          parts.push(`[image:${"mimeType" in block ? String(block.mimeType) : "unknown"}]`);
        } else if (block.type === "toolCall" && "name" in block) {
          parts.push(
            `[toolCall ${String(block.name)}(${JSON.stringify("arguments" in block ? block.arguments : {})})]`,
          );
        } else if (block.type === "thinking" && "thinking" in block) {
          parts.push(`[thinking: ${String(block.thinking)}]`);
        }
      }
      text = parts.join("\n");
    }
  }

  return {
    index,
    role,
    ...(customType ? { customType } : {}),
    ...(toolName ? { toolName } : {}),
    ...(isError !== undefined ? { isError } : {}),
    text,
    imageCount,
  };
}

function extractSystemSections(systemMessages: readonly SystemMessage[]): AnalyzedSystemSection[] {
  const merged = new Map<string, string>();
  for (const message of systemMessages) {
    if (!message.sections) continue;
    for (const [name, value] of Object.entries(message.sections)) {
      if (value === null) merged.delete(name);
      else merged.set(name, value);
    }
  }
  return [...merged.entries()].map(([name, value]) => ({
    name,
    chars: value.length,
    tokens: estimateTextTokens(value),
  }));
}

function summarizeTool(tool: Tool): AnalyzedToolSummary {
  const description = tool.description ?? "";
  const schemaText = JSON.stringify(tool.parameters ?? {});
  const totalChars = tool.name.length + description.length + schemaText.length;
  return {
    name: tool.name,
    description,
    descriptionChars: description.length,
    schemaChars: schemaText.length,
    totalChars,
    estimatedTokens: estimateTextTokens(`${tool.name}\n${description}\n${schemaText}`),
  };
}

function mapContextMetaToTranscript(
  contextWithSystem: readonly CapturedAgentMessageEntry[],
  transcriptMessages: readonly Message[],
): Map<number, CapturedAgentMessageEntry> {
  const mapping = new Map<number, CapturedAgentMessageEntry>();
  let cursor = 0;
  for (const [transcriptIndex, message] of transcriptMessages.entries()) {
    if (message.role === "system") continue;
    const text = renderMessageTextForAnalysis(message);
    for (let i = cursor; i < contextWithSystem.length; i += 1) {
      const candidate = contextWithSystem[i]!;
      if (candidate.role === "system") continue;
      if (
        candidate.text === text ||
        (candidate.role === "custom" && message.role === "user" && candidate.text === text)
      ) {
        mapping.set(transcriptIndex, candidate);
        cursor = i + 1;
        break;
      }
    }
  }
  return mapping;
}

function classifyMessageKind(message: Message, customType?: string): string {
  if (customType === TURN_CONTEXT_CUSTOM_TYPE) return "turn-context";
  if (customType === "klein-context-handoff") return "context-handoff";
  if (customType === "klein-image-analysis") return "image-analysis";
  if (customType === "klein-image-analysis-error") return "image-analysis-error";
  if (customType) return `custom:${customType}`;
  if (message.role === "user") {
    const text = renderMessageTextForAnalysis(message);
    if (text.includes("<event-metadata>")) return "event";
    if (text.includes("<previous-conversation-context>")) return "context-handoff";
    if (text.includes("<image-analysis")) return "image-analysis";
    if (
      text.includes("<owner-memory>") ||
      text.includes("<user-memory>") ||
      text.includes("<guild-memory>") ||
      text.includes("<channel-rule>")
    ) {
      return "turn-context";
    }
    return "user";
  }
  if (message.role === "assistant") {
    return message.content.some((block) => block.type === "toolCall")
      ? "assistant-tool-call"
      : "assistant-text";
  }
  if (message.role === "toolResult") {
    return `tool-result:${message.toolName}`;
  }
  return message.role;
}

function renderMessageTextForAnalysis(message: Message): string {
  if (message.role === "system") return getSystemMessageText(message);
  if (typeof message.content === "string") return message.content;

  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[image:${block.mimeType}]`);
    } else if (block.type === "toolCall") {
      parts.push(`[toolCall ${block.name}(${JSON.stringify(block.arguments)})]`);
    } else if (block.type === "thinking") {
      parts.push(`[thinking: ${block.thinking}]`);
    }
  }
  return parts.join("\n");
}

function countMessageImages(message: Message): number {
  if (message.role === "system" || typeof message.content === "string") return 0;
  return message.content.filter((block) => block.type === "image").length;
}

function extractProviderPayloadView(
  api: string,
  payload: unknown,
): ProviderPayloadView | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  if (api === "google-generative-ai" || api === "google-vertex") {
    const config = (record.config ?? {}) as Record<string, unknown>;
    const systemInstruction =
      typeof config.systemInstruction === "string" ? config.systemInstruction : "";
    const toolsRaw = Array.isArray(config.tools) ? config.tools : [];
    const toolNames: string[] = [];
    for (const toolEntry of toolsRaw) {
      if (!toolEntry || typeof toolEntry !== "object") continue;
      const decls = (toolEntry as Record<string, unknown>).functionDeclarations;
      if (Array.isArray(decls)) {
        for (const decl of decls) {
          if (decl && typeof decl === "object" && "name" in decl) {
            toolNames.push(String((decl as Record<string, unknown>).name));
          }
        }
      }
    }
    const contents = Array.isArray(record.contents) ? record.contents : [];
    const roles = contents.map((item) =>
      item && typeof item === "object" && "role" in item
        ? String((item as Record<string, unknown>).role)
        : "unknown",
    );
    return {
      api,
      systemInstructionChars: systemInstruction.length,
      toolCount: toolNames.length,
      toolNames,
      messageCount: contents.length,
      messageRoles: roles,
    };
  }

  if (Array.isArray(record.messages)) {
    const messages = record.messages;
    const roles = messages.map((item) =>
      item && typeof item === "object" && "role" in item
        ? String((item as Record<string, unknown>).role)
        : "unknown",
    );
    const systemInstructionChars = messages
      .filter(
        (item): item is Record<string, unknown> =>
          !!item &&
          typeof item === "object" &&
          ((item as Record<string, unknown>).role === "system" ||
            (item as Record<string, unknown>).role === "developer"),
      )
      .reduce((sum, item) => sum + JSON.stringify(item.content ?? "").length, 0);

    const toolsRaw = Array.isArray(record.tools) ? record.tools : [];
    const toolNames = toolsRaw
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const fn = (item as Record<string, unknown>).function;
        if (fn && typeof fn === "object" && "name" in fn) {
          return String((fn as Record<string, unknown>).name);
        }
        if ("name" in item) return String((item as Record<string, unknown>).name);
        return undefined;
      })
      .filter((name): name is string => name !== undefined);

    return {
      api,
      systemInstructionChars,
      toolCount: toolNames.length,
      toolNames,
      messageCount: messages.length,
      messageRoles: roles,
    };
  }

  return undefined;
}

function normalizeProviderPayloadForCache(api: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;

  if (api === "google-generative-ai" || api === "google-vertex") {
    const config =
      record.config && typeof record.config === "object"
        ? (record.config as Record<string, unknown>)
        : {};
    const { systemInstruction, tools, ...restConfig } = config;
    return {
      model: record.model,
      systemInstruction,
      tools,
      contents: record.contents,
      config: restConfig,
    };
  }

  if (Array.isArray(record.messages)) {
    const messages = record.messages as Array<Record<string, unknown>>;
    const systemMessages = messages.filter(
      (item) => item?.role === "system" || item?.role === "developer",
    );
    const nonSystemMessages = messages.filter(
      (item) => item?.role !== "system" && item?.role !== "developer",
    );
    return {
      model: record.model,
      systemMessages,
      tools: record.tools,
      messages: nonSystemMessages,
    };
  }

  return payload;
}

function stripTimestamps(message: Message): unknown {
  const cloned = structuredClone(message) as unknown as Record<string, unknown>;
  delete cloned.timestamp;
  return cloned;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

function findFirstJsonDiffPath(left: unknown, right: unknown, path = "$"): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null) return path;
  if (typeof left !== "object") return path;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    const min = Math.min(left.length, right.length);
    for (let i = 0; i < min; i += 1) {
      const diff = findFirstJsonDiffPath(left[i], right[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return left.length === right.length ? undefined : `${path}[${min}]`;
  }

  const leftObj = left as Record<string, unknown>;
  const rightObj = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftObj), ...Object.keys(rightObj)]);
  for (const key of keys) {
    if (!(key in leftObj) || !(key in rightObj)) return `${path}.${key}`;
    const diff = findFirstJsonDiffPath(leftObj[key], rightObj[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return undefined;
}

function countMatches(text: string, regex: RegExp): number {
  return text.match(regex)?.length ?? 0;
}

function toPreview(text: string, maxLength = 120): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
