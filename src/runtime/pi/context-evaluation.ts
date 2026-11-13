import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getSystemMessageText,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FauxResponseStep,
  type Message,
  type Model,
  type ModelsSimpleStreamOptions,
  type SystemMessage,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type ContextWithSystemEvent,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TURN_CONTEXT_CUSTOM_TYPE } from "./pi-turn-context";

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

export function buildContextJudgePrompt(reportMarkdown: string): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    "You are an expert LLM context engineer auditing the final serialized API request payloads of a Discord communication agent.",
    "Evaluate strictly what is present in the report: system prompt, tool definitions, custom messages, event metadata, and message ordering.",
    "Respond in Japanese using valid JSON matching the requested schema.",
  ].join("\n");

  const userPrompt = [
    "以下の最終送信コンテキスト評価レポートを精査し、プロンプト・ツール・イベント・カスタムメッセージの順番と品質を評価してください。",
    "",
    "評価観点:",
    "1. ordering_and_boundaries: システム指示、記憶(<user-memory>/<guild-memory>/<owner-memory>/<channel-rule>)、ハンドオフ、画像解析、イベントメタデータ、完了ターン要約の順序がモデルにとって明確か。",
    "2. instruction_consistency: SOUL.md・システムルール・スキル・ツール説明・チャンネルルールの間で矛盾・重複・曖昧さがないか。",
    "3. tool_clarity_and_budget: ツール一覧やJSON Schemaの重複・紛らわしさ・トークン効率の問題がないか。",
    "4. untrusted_data_isolation: Discord発言や画像解析結果などの外部非信頼データとシステム指示の境界が堅牢か。",
    '5. turn_target_clarity: 複数ユーザー発言・ステアリング・過去の"Sent a message to Discord."置換が混在したときに「今誰に何を返すべきか」を誤認しないか。',
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
