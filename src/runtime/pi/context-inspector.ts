import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";

import {
  createAssistantMessageEventStream,
  createInitialSystemMessage,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getSystemMessageText,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
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

export type SessionReplayMode = "turn-start" | "pre-message";

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
  readonly systemPrompt: string;
  readonly systemMessages: readonly SystemMessage[];
  readonly tools: readonly Tool[];
  readonly contextWithSystem: readonly CapturedAgentMessageEntry[];
  readonly transcriptMessages: readonly Message[];
  readonly providerPayload: unknown;
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
}

export interface ProviderPayloadView {
  readonly api: string;
  readonly systemInstructionChars: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly messageCount: number;
  readonly messageRoles: readonly string[];
}

export interface ContextTokenAnalysis {
  readonly requestIndex: number;
  readonly label?: string;
  readonly model: CapturedLlmRequest["model"];
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

export interface ContextJudgeFeedbackContext {
  readonly caseId?: string;
  readonly reaction?: EvalFeedbackCase["reaction"];
  readonly recordedResponse?: EvalFeedbackCase["recordedResponse"];
  readonly replayedSentMessages?: readonly string[];
  readonly replayedFinalAssistantText?: string;
}

export interface RunContextJudgeOptions {
  readonly reportMarkdown: string;
  readonly feedbackContext?: ContextJudgeFeedbackContext;
  readonly provider: string;
  readonly model: string;
  readonly runtimeAgentDir?: string;
  readonly modelRuntime?: ModelRuntime;
}

export interface RecordedTurnStep {
  readonly entryId?: string;
  readonly timestamp?: string;
  readonly role: string;
  readonly customType?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly thinking?: string;
  readonly text: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }[];
  readonly imageCount: number;
}

export interface RecordedTurnTrace {
  readonly turnIndex?: number;
  readonly turnStartEntryId?: string;
  readonly turnContextText?: string;
  readonly userText?: string;
  readonly steps: readonly RecordedTurnStep[];
  readonly recordedResponseContent?: string;
  readonly assistantTextBeforeCall?: string;
}

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

export interface InspectSessionOptions {
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
  readonly runtimeAgentDir?: string;
  readonly captureProviderPayload?: boolean;
  readonly label?: string;
  readonly traceSourceEntries?: readonly FileEntry[];
  readonly targetAssistantEntryId?: string;
  readonly recordedResponseContent?: string;
  readonly assistantTextBeforeCall?: string;
}

export interface InspectSessionResult {
  readonly sessionId: string;
  readonly mode: SessionReplayMode;
  readonly turns: readonly ExtractedSessionTurn[];
  readonly trace?: RecordedTurnTrace;
  readonly requests: readonly CapturedLlmRequest[];
}

export interface ReplaySessionOptions extends InspectSessionOptions {
  readonly modelRuntime?: ModelRuntime;
}

export interface ReplaySessionResult {
  readonly sessionId: string;
  readonly mode: SessionReplayMode;
  readonly turns: readonly ExtractedSessionTurn[];
  readonly trace?: RecordedTurnTrace;
  readonly sentMessages: readonly string[];
  readonly finalAssistantText?: string;
  readonly replaySteps: readonly RecordedTurnStep[];
  readonly requests: readonly CapturedLlmRequest[];
}

export function extractSessionTurns(entries: readonly FileEntry[]): ExtractedSessionTurn[] {
  if (entries.length === 0) return [];
  const manager = SessionManager.inMemory(process.cwd(), undefined, [...entries]);
  const branch = manager.getBranch();
  const turns: ExtractedSessionTurn[] = [];
  let current:
    | {
        turnIndex: number;
        userEntryId: string;
        timestamp: string;
        userText: string;
        images: readonly ImageContent[];
        turnContextEntryId?: string;
        hasTurnContext: boolean;
        firstAssistantEntryId?: string;
        discordSendAssistantEntryId?: string;
        assistantEntryId?: string;
        assistantText?: string;
        discordSendContents: string[];
      }
    | undefined;
  let pendingTurnContextEntryId: string | undefined;

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === TURN_CONTEXT_CUSTOM_TYPE) {
      pendingTurnContextEntryId = entry.id;
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "user") {
      if (current) {
        turns.push(current);
      }
      const { userText, images } = extractUserMessageParts(message.content);
      current = {
        turnIndex: turns.length,
        userEntryId: entry.id,
        timestamp: entry.timestamp,
        userText,
        images,
        turnContextEntryId: pendingTurnContextEntryId,
        hasTurnContext: pendingTurnContextEntryId !== undefined,
        discordSendContents: [],
      };
      pendingTurnContextEntryId = undefined;
      continue;
    }

    if (!current || message.role !== "assistant") continue;

    if (!current.firstAssistantEntryId) {
      current.firstAssistantEntryId = entry.id;
    }
    current.assistantEntryId = entry.id;

    const textParts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        textParts.push(block.text.trim());
      } else if (
        block.type === "toolCall" &&
        block.name === "discord_send" &&
        typeof block.arguments?.content === "string"
      ) {
        if (!current.discordSendAssistantEntryId) {
          current.discordSendAssistantEntryId = entry.id;
        }
        current.discordSendContents.push(block.arguments.content);
      }
    }
    if (textParts.length > 0) {
      current.assistantText = textParts.join("\n");
    }
  }

  if (current) {
    turns.push(current);
  }
  return turns;
}

export function extractTurnTraceFromEntries(
  entries: readonly FileEntry[],
  options: {
    readonly turnIndex?: number;
    readonly targetAssistantEntryId?: string;
    readonly recordedResponseContent?: string;
    readonly assistantTextBeforeCall?: string;
  } = {},
): RecordedTurnTrace | undefined {
  if (entries.length === 0) return undefined;

  const manager = SessionManager.inMemory(process.cwd(), undefined, [...entries]);
  const branch = options.targetAssistantEntryId
    ? (() => {
        try {
          return buildLinearBranchBeforeEntry(entries, options.targetAssistantEntryId, {
            inclusive: true,
          }).branchEntries;
        } catch {
          return manager.getBranch();
        }
      })()
    : manager.getBranch();

  let startUserIdx = -1;
  if (options.targetAssistantEntryId) {
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i]!;
      if (entry.type === "message" && entry.message.role === "user") {
        startUserIdx = i;
        break;
      }
    }
  } else {
    const turns = extractSessionTurns(entries);
    if (turns.length === 0) return undefined;
    const rawIdx = options.turnIndex ?? turns.length - 1;
    const normalizedIdx = rawIdx < 0 ? turns.length + rawIdx : rawIdx;
    const targetTurn = turns[normalizedIdx];
    if (!targetTurn) return undefined;
    startUserIdx = branch.findIndex((entry) => entry.id === targetTurn.userEntryId);
  }

  if (startUserIdx < 0) return undefined;

  let turnContextText: string | undefined;
  for (let i = startUserIdx - 1; i >= 0; i -= 1) {
    const prev = branch[i]!;
    if (prev.type === "custom" && prev.customType === TURN_CONTEXT_CUSTOM_TYPE) {
      turnContextText = renderCustomContent(prev.data);
      break;
    }
    if (prev.type === "message") break;
  }

  const startEntry = branch[startUserIdx]!;
  const userText =
    startEntry.type === "message" && startEntry.message.role === "user"
      ? extractUserMessageParts(startEntry.message.content).userText
      : undefined;

  const steps: RecordedTurnStep[] = [];
  for (let i = startUserIdx; i < branch.length; i += 1) {
    const entry = branch[i]!;
    if (i > startUserIdx && entry.type === "message" && entry.message.role === "user") {
      break;
    }
    const step = sessionEntryToStep(entry);
    if (step) {
      steps.push(step);
    }
  }

  return {
    ...(options.turnIndex !== undefined ? { turnIndex: options.turnIndex } : {}),
    turnStartEntryId: startEntry.id,
    ...(turnContextText ? { turnContextText } : {}),
    ...(userText !== undefined ? { userText } : {}),
    steps,
    ...(options.recordedResponseContent !== undefined
      ? { recordedResponseContent: options.recordedResponseContent }
      : {}),
    ...(options.assistantTextBeforeCall !== undefined
      ? { assistantTextBeforeCall: options.assistantTextBeforeCall }
      : {}),
  };
}

export async function inspectSessionEntries(
  options: InspectSessionOptions,
): Promise<InspectSessionResult> {
  if (options.allTurns && !options.preSliced) {
    const turns = extractSessionTurns(options.entries);
    if (turns.length === 0) {
      const header = options.entries.find((entry) => entry.type === "session");
      return {
        sessionId: header?.id ?? "unknown",
        mode: options.mode ?? "turn-start",
        turns: [],
        requests: [],
      };
    }

    const selected =
      options.maxTurns !== undefined && options.maxTurns > 0
        ? turns.slice(-options.maxTurns)
        : turns;

    let sessionId = "unknown";
    const allRequests: CapturedLlmRequest[] = [];
    let lastTrace: RecordedTurnTrace | undefined;

    for (const turn of selected) {
      const res = await executeSessionSlice(
        {
          ...options,
          turnIndex: turn.turnIndex,
          allTurns: false,
          label: options.label
            ? `${options.label}:turn-${turn.turnIndex}`
            : `turn-${turn.turnIndex}`,
        },
        { liveReplay: false },
      );
      sessionId = res.sessionId;
      if (res.trace) lastTrace = res.trace;
      for (const req of res.requests) {
        allRequests.push({
          ...req,
          index: allRequests.length,
        });
      }
    }

    return {
      sessionId,
      mode: options.mode ?? "turn-start",
      turns,
      ...(lastTrace ? { trace: lastTrace } : {}),
      requests: allRequests,
    };
  }

  const executed = await executeSessionSlice(options, {
    liveReplay: false,
  });
  return {
    sessionId: executed.sessionId,
    mode: executed.mode,
    turns: executed.turns,
    ...(executed.trace ? { trace: executed.trace } : {}),
    requests: executed.requests,
  };
}

export async function inspectFeedbackCase(
  loadedCase: LoadedEvalFeedbackCase,
  options: Omit<
    InspectSessionOptions,
    | "entries"
    | "preSliced"
    | "turnIndex"
    | "allTurns"
    | "maxTurns"
    | "traceSourceEntries"
    | "targetAssistantEntryId"
    | "recordedResponseContent"
    | "assistantTextBeforeCall"
  > = {},
): Promise<InspectSessionResult> {
  const mode = inferFeedbackCaseMode(loadedCase, options.mode);
  const traceSourceEntries = await loadFeedbackTraceEntries(loadedCase);

  return inspectSessionEntries({
    ...options,
    entries: loadedCase.entries,
    mode,
    preSliced: mode === "pre-message",
    ownerFeaturesAllowed:
      options.ownerFeaturesAllowed ?? loadedCase.caseMeta.sourceSession.ownerFeaturesAllowed,
    sessionKey: options.sessionKey ?? loadedCase.caseMeta.sourceSession.sessionKey,
    label: options.label ?? `case:${loadedCase.caseMeta.caseId}`,
    traceSourceEntries,
    targetAssistantEntryId: loadedCase.caseMeta.slice.targetAssistantEntryId,
    recordedResponseContent: loadedCase.caseMeta.recordedResponse.content,
    assistantTextBeforeCall: loadedCase.caseMeta.recordedResponse.assistantTextBeforeCall,
  });
}

export async function replaySessionEntries(
  options: ReplaySessionOptions,
): Promise<ReplaySessionResult> {
  const executed = await executeSessionSlice(options, {
    liveReplay: true,
    modelRuntime: options.modelRuntime,
  });
  return {
    sessionId: executed.sessionId,
    mode: executed.mode,
    turns: executed.turns,
    ...(executed.trace ? { trace: executed.trace } : {}),
    sentMessages: executed.sentMessages,
    ...(executed.finalAssistantText ? { finalAssistantText: executed.finalAssistantText } : {}),
    replaySteps: executed.replaySteps,
    requests: executed.requests,
  };
}

export async function replayFeedbackCase(
  loadedCase: LoadedEvalFeedbackCase,
  options: Omit<
    ReplaySessionOptions,
    | "entries"
    | "preSliced"
    | "turnIndex"
    | "allTurns"
    | "maxTurns"
    | "traceSourceEntries"
    | "targetAssistantEntryId"
    | "recordedResponseContent"
    | "assistantTextBeforeCall"
  > = {},
): Promise<ReplaySessionResult> {
  const mode = inferFeedbackCaseMode(loadedCase, options.mode);
  const traceSourceEntries = await loadFeedbackTraceEntries(loadedCase);

  return replaySessionEntries({
    ...options,
    entries: loadedCase.entries,
    mode,
    preSliced: mode === "pre-message",
    ownerFeaturesAllowed:
      options.ownerFeaturesAllowed ?? loadedCase.caseMeta.sourceSession.ownerFeaturesAllowed,
    sessionKey: options.sessionKey ?? loadedCase.caseMeta.sourceSession.sessionKey,
    label: options.label ?? `case:${loadedCase.caseMeta.caseId}`,
    traceSourceEntries,
    targetAssistantEntryId: loadedCase.caseMeta.slice.targetAssistantEntryId,
    recordedResponseContent: loadedCase.caseMeta.recordedResponse.content,
    assistantTextBeforeCall: loadedCase.caseMeta.recordedResponse.assistantTextBeforeCall,
  });
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

export function analyzeCapturedRequest(request: CapturedLlmRequest): ContextTokenAnalysis {
  const systemSections = extractSystemSections(request.systemMessages);
  const tools = request.tools.map(summarizeTool);

  const messages: AnalyzedMessageSummary[] = [];
  for (const [index, message] of request.transcriptMessages.entries()) {
    if (message.role === "system") continue;
    const text = renderMessageTextForDisplay(message);
    const imageCount = countMessageImages(message);
    const matchedMeta = findMatchingContextMeta(request.contextWithSystem, message, index);
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
    });
  }

  const systemPromptChars = request.systemPrompt.length;
  const systemPromptTokens = estimateTextTokens(request.systemPrompt);
  const toolsTotalChars = tools.reduce((sum, tool) => sum + tool.totalChars, 0);
  const toolsTotalTokens = tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
  const messagesTotalChars = messages.reduce((sum, message) => sum + message.chars, 0);
  const messagesTotalTokens = messages.reduce((sum, message) => sum + message.estimatedTokens, 0);
  const totalChars = systemPromptChars + toolsTotalChars + messagesTotalChars;
  const totalEstimatedTokens = systemPromptTokens + toolsTotalTokens + messagesTotalTokens;
  const providerView = extractProviderPayloadView(request.model.api, request.providerPayload);

  return {
    requestIndex: request.index,
    ...(request.label ? { label: request.label } : {}),
    model: request.model,
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

export function buildContextJudgePrompt(
  reportMarkdown: string,
  feedbackContext?: ContextJudgeFeedbackContext,
): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    "You are an expert LLM context engineer investigating why a Discord communication agent behaved as it did.",
    "Analyze strictly what is visible in the raw context report: system prompt, tool definitions, turn context, tool calls/results, and message history.",
    "Respond in Japanese using valid JSON matching the requested schema.",
  ].join("\n");

  const feedbackLines: string[] = [];
  if (feedbackContext?.caseId || feedbackContext?.reaction || feedbackContext?.recordedResponse) {
    feedbackLines.push("", "記録されたネガティブフィードバック情報:");
    if (feedbackContext.caseId) feedbackLines.push(`- Case ID: ${feedbackContext.caseId}`);
    if (feedbackContext.reaction) {
      feedbackLines.push(
        `- Reaction: ${feedbackContext.reaction.emoji} by ${feedbackContext.reaction.userId} (isOwner=${feedbackContext.reaction.isOwner}, occurredAt=${feedbackContext.reaction.occurredAt})`,
      );
    }
    if (feedbackContext.recordedResponse) {
      feedbackLines.push(
        `- Recorded Discord Response: ${JSON.stringify(feedbackContext.recordedResponse.content)}`,
      );
      if (feedbackContext.recordedResponse.assistantTextBeforeCall) {
        feedbackLines.push(
          `- Assistant Text Before Call: ${JSON.stringify(feedbackContext.recordedResponse.assistantTextBeforeCall)}`,
        );
      }
    }
    feedbackLines.push(
      "このコンテキスト状態でなぜ上記の応答が出力され、不適切・不十分と評価されたかを、具体的な根拠を挙げて分析してください。",
    );
  }
  if (
    feedbackContext?.replayedSentMessages !== undefined ||
    feedbackContext?.replayedFinalAssistantText !== undefined
  ) {
    feedbackLines.push("", "実API再現での出力:");
    feedbackLines.push(
      `- Replayed discord_send: ${JSON.stringify(feedbackContext.replayedSentMessages ?? [])}`,
    );
    if (feedbackContext.replayedFinalAssistantText) {
      feedbackLines.push(
        `- Replayed Final Assistant Text: ${JSON.stringify(feedbackContext.replayedFinalAssistantText)}`,
      );
    }
    feedbackLines.push("元の応答と比較して再現結果がどう変化したかも評価してください。");
  }

  const userPrompt = [
    "以下の生コンテキスト調査レポートを読み解き、モデルに何がどう伝わってその振る舞いに至ったか、またコンテキスト設計・プロンプト・ツール・キャッシュ効率上の課題がないかを評価してください。",
    "",
    "評価観点:",
    "1. root_cause_and_context_flow: どの記憶・ルール・過去履歴・ツール結果・システム指示が問題の判断を誘発したか。",
    "2. instruction_and_tool_clarity: SOUL.md・スキル・ツール説明・チャンネルルールの間で矛盾・曖昧さ・過剰さがないか。",
    "3. boundary_and_target_clarity: 複数ユーザー発言・過去要約・外部データの境界や宛先認識が明確か。",
    "4. token_and_cache_efficiency: トークン配分やPrefix Cacheの観点から無駄やキャッシュ破壊がないか。",
    ...feedbackLines,
    "",
    "出力JSONスキーマ:",
    "{",
    '  "summary": "全体の要約と原因の仮説",',
    '  "scores": { "root_cause_clarity": 1-5, "instruction_consistency": 1-5, "tool_clarity_and_budget": 1-5, "boundary_and_target_clarity": 1-5, "token_and_cache_efficiency": 1-5 },',
    '  "findings": [{ "severity": "high|medium|low", "area": "...", "evidence": "...", "recommendation": "..." }]',
    "}",
    "",
    "--- REPORT ---",
    reportMarkdown,
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export async function runContextJudge(options: RunContextJudgeOptions): Promise<string> {
  const runtime =
    options.modelRuntime ??
    (await createPiModelRuntime(resolve(options.runtimeAgentDir ?? ".runtime/pi")));
  const model = resolveConfiguredModel(options.provider, options.model, runtime);
  const prompt = buildContextJudgePrompt(options.reportMarkdown, options.feedbackContext);

  const response = await runtime.completeSimple(
    model,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [
        {
          role: "user",
          content: prompt.userPrompt,
          timestamp: Date.now(),
        },
      ],
    },
    {
      cacheRetention: "none",
      maxTokens: 2048,
    },
  );

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function formatContextInspectionMarkdown(
  result: InspectSessionResult,
  options: {
    readonly title?: string;
    readonly includeTools?: boolean;
    readonly includeProviderPayload?: boolean;
    readonly caseMeta?: EvalFeedbackCase;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${options.title ?? `Context Inspection (${result.sessionId})`}`);
  lines.push("");
  lines.push(`- Session ID: \`${result.sessionId}\``);
  lines.push(`- Mode: \`${result.mode}\``);

  if (options.caseMeta) {
    lines.push(`- Case ID: \`${options.caseMeta.caseId}\``);
    lines.push(
      `- Reaction: ${options.caseMeta.reaction.emoji} by \`${options.caseMeta.reaction.userId}\` (isOwner=${options.caseMeta.reaction.isOwner}, at=${options.caseMeta.reaction.occurredAt})`,
    );
    lines.push(`- Session Key: \`${options.caseMeta.sourceSession.sessionKey}\``);
    lines.push(`- Owner Features Allowed: ${options.caseMeta.sourceSession.ownerFeaturesAllowed}`);
  }
  lines.push("");

  appendTokenAndCacheSummaryMarkdown(lines, result.requests);

  if (result.trace) {
    appendTraceMarkdown(lines, result.trace);
  }

  for (const request of result.requests) {
    appendRequestMarkdown(lines, request, {
      includeTools: options.includeTools ?? true,
      includeProviderPayload: options.includeProviderPayload ?? false,
    });
  }

  return lines.join("\n");
}

export function formatReplayResultMarkdown(
  result: ReplaySessionResult,
  options: {
    readonly title?: string;
    readonly includeTools?: boolean;
    readonly includeProviderPayload?: boolean;
    readonly caseMeta?: EvalFeedbackCase;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${options.title ?? `Live Replay (${result.sessionId})`}`);
  lines.push("");
  lines.push(`- Session ID: \`${result.sessionId}\``);
  lines.push(`- Mode: \`${result.mode}\``);
  if (options.caseMeta) {
    lines.push(`- Case ID: \`${options.caseMeta.caseId}\``);
    lines.push(
      `- Reaction: ${options.caseMeta.reaction.emoji} by \`${options.caseMeta.reaction.userId}\` (isOwner=${options.caseMeta.reaction.isOwner})`,
    );
  }
  lines.push("");

  lines.push("## Replay Outcome vs Recorded Response");
  lines.push("");
  if (result.trace?.recordedResponseContent !== undefined || options.caseMeta) {
    const recorded =
      result.trace?.recordedResponseContent ?? options.caseMeta?.recordedResponse.content ?? "";
    lines.push("### Recorded Response (Original)");
    lines.push("````text");
    lines.push(recorded);
    lines.push("````");
    lines.push("");
  }

  lines.push("### Replayed `discord_send` Output");
  if (result.sentMessages.length === 0) {
    lines.push("_No `discord_send` call was made (bot stayed silent)._");
  } else {
    for (const [idx, msg] of result.sentMessages.entries()) {
      lines.push(`#### Sent #${idx + 1}`);
      lines.push("````text");
      lines.push(msg);
      lines.push("````");
    }
  }
  lines.push("");

  if (result.finalAssistantText) {
    lines.push("### Replayed Final Assistant Text");
    lines.push("````text");
    lines.push(result.finalAssistantText);
    lines.push("````");
    lines.push("");
  }

  if (result.replaySteps.length > 0) {
    lines.push("## Replayed Turn Steps");
    lines.push("");
    appendStepsMarkdown(lines, result.replaySteps);
  }

  appendTokenAndCacheSummaryMarkdown(lines, result.requests);

  if (result.trace) {
    appendTraceMarkdown(lines, result.trace);
  }

  for (const request of result.requests) {
    appendRequestMarkdown(lines, request, {
      includeTools: options.includeTools ?? false,
      includeProviderPayload: options.includeProviderPayload ?? false,
    });
  }

  return lines.join("\n");
}

function appendTokenAndCacheSummaryMarkdown(
  lines: string[],
  requests: readonly CapturedLlmRequest[],
): void {
  if (requests.length === 0) return;

  const analyses = requests.map(analyzeCapturedRequest);
  lines.push("## Token & Cache Reference");
  lines.push("");
  lines.push(
    "| # | Label | Model | System Tokens | Tools (count / tokens) | Messages (count / tokens) | Total Est. Tokens |",
  );
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const analysis of analyses) {
    lines.push(
      `| ${analysis.requestIndex} | ${escapeTableCell(analysis.label ?? "-")} | ${analysis.model.provider}/${analysis.model.id} | ${analysis.systemPromptTokens} | ${analysis.tools.length} / ${analysis.toolsTotalTokens} | ${analysis.messages.length} / ${analysis.messagesTotalTokens} | ${analysis.totalEstimatedTokens} |`,
    );
  }
  lines.push("");

  if (requests.length >= 2) {
    lines.push("### Prefix Cache Stability");
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

  const first = analyses[0];
  if (first && first.systemSections.length > 0) {
    lines.push("### System Prompt Sections (#0)");
    lines.push("");
    for (const section of first.systemSections) {
      lines.push(`- \`${section.name}\`: ${section.chars} chars (~${section.tokens} tokens)`);
    }
    lines.push("");
  }
}

function appendTraceMarkdown(lines: string[], trace: RecordedTurnTrace): void {
  lines.push("## Recorded Turn Trace (What Happened Originally)");
  lines.push("");
  if (trace.turnContextText) {
    lines.push("### Turn Context (`klein-turn-context`)");
    lines.push("````text");
    lines.push(trace.turnContextText);
    lines.push("````");
    lines.push("");
  }

  if (trace.steps.length > 0) {
    lines.push("### Steps");
    lines.push("");
    appendStepsMarkdown(lines, trace.steps);
  }

  if (trace.assistantTextBeforeCall) {
    lines.push("### Recorded Assistant Reasoning Text Before `discord_send`");
    lines.push("````text");
    lines.push(trace.assistantTextBeforeCall);
    lines.push("````");
    lines.push("");
  }

  if (trace.recordedResponseContent !== undefined) {
    lines.push("### Recorded `discord_send` Content");
    lines.push("````text");
    lines.push(trace.recordedResponseContent);
    lines.push("````");
    lines.push("");
  }
}

function appendStepsMarkdown(lines: string[], steps: readonly RecordedTurnStep[]): void {
  for (const [idx, step] of steps.entries()) {
    const labelParts = [`role=\`${step.role}\``];
    if (step.customType) labelParts.push(`customType=\`${step.customType}\``);
    if (step.toolName) labelParts.push(`tool=\`${step.toolName}\``);
    if (step.isError) labelParts.push(`isError=true`);
    lines.push(`#### Step ${idx + 1}: ${labelParts.join(" ")}`);
    if (step.thinking) {
      lines.push("Thinking:");
      lines.push("````text");
      lines.push(step.thinking);
      lines.push("````");
    }
    if (step.text) {
      lines.push("Text:");
      lines.push("````text");
      lines.push(step.text);
      lines.push("````");
    }
    if (step.toolCalls && step.toolCalls.length > 0) {
      lines.push("Tool Calls:");
      for (const call of step.toolCalls) {
        lines.push(`- \`${call.name}\` (${call.id}):`);
        lines.push("````json");
        lines.push(JSON.stringify(call.arguments, null, 2));
        lines.push("````");
      }
    }
    lines.push("");
  }
}

function appendRequestMarkdown(
  lines: string[],
  request: CapturedLlmRequest,
  options: {
    readonly includeTools: boolean;
    readonly includeProviderPayload: boolean;
  },
): void {
  lines.push(
    `## Raw Request #${request.index}${request.label ? ` (${request.label})` : ""} — \`${request.model.provider}/${request.model.id}\``,
  );
  lines.push("");

  lines.push("### System Prompt (Raw)");
  lines.push("````markdown");
  lines.push(request.systemPrompt);
  lines.push("````");
  lines.push("");

  if (options.includeTools) {
    lines.push(`### Declared Tools (${request.tools.length})`);
    lines.push("````json");
    lines.push(
      JSON.stringify(
        request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        null,
        2,
      ),
    );
    lines.push("````");
    lines.push("");
  }

  lines.push("### Transcript Messages Sent to Model (Raw)");
  lines.push("");
  for (const [index, message] of request.transcriptMessages.entries()) {
    if (message.role === "system") continue;
    const contextMeta = findMatchingContextMeta(request.contextWithSystem, message, index);
    const metaParts = [`role=\`${message.role}\``];
    if (contextMeta?.customType) metaParts.push(`customType=\`${contextMeta.customType}\``);
    if (message.role === "toolResult") {
      metaParts.push(`tool=\`${message.toolName}\``);
      if (message.isError) metaParts.push(`isError=true`);
    }
    lines.push(`#### [${index}] ${metaParts.join(" ")}`);
    lines.push("````text");
    lines.push(renderMessageTextForDisplay(message));
    lines.push("````");
    lines.push("");
  }

  if (options.includeProviderPayload && request.providerPayload !== undefined) {
    lines.push("### Provider HTTP Payload (Raw JSON)");
    lines.push("````json");
    lines.push(JSON.stringify(request.providerPayload, null, 2));
    lines.push("````");
    lines.push("");
  }
}

function inferFeedbackCaseMode(
  loadedCase: LoadedEvalFeedbackCase,
  explicitMode?: SessionReplayMode,
): SessionReplayMode {
  if (explicitMode) return explicitMode;
  const lastRole = findLastMessageRole(loadedCase.entries);
  return loadedCase.caseMeta.slice.turnStartEntryId && lastRole === "user"
    ? "turn-start"
    : "pre-message";
}

async function loadFeedbackTraceEntries(
  loadedCase: LoadedEvalFeedbackCase,
): Promise<readonly FileEntry[]> {
  const originalPath = loadedCase.caseMeta.sourceSession.originalSessionFile;
  if (originalPath) {
    try {
      const raw = await readFile(originalPath, "utf8");
      const { parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
      const parsed = parseSessionEntries(raw);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Fall back to the snapshot session file when the original file is unavailable.
    }
  }
  return loadedCase.entries;
}

async function executeSessionSlice(
  options: InspectSessionOptions,
  exec: {
    readonly liveReplay: boolean;
    readonly modelRuntime?: ModelRuntime;
  },
): Promise<{
  readonly sessionId: string;
  readonly mode: SessionReplayMode;
  readonly turns: readonly ExtractedSessionTurn[];
  readonly trace?: RecordedTurnTrace;
  readonly sentMessages: readonly string[];
  readonly finalAssistantText?: string;
  readonly replaySteps: readonly RecordedTurnStep[];
  readonly requests: readonly CapturedLlmRequest[];
}> {
  const header = options.entries.find((entry) => entry.type === "session");
  if (!header) {
    throw new Error("Session entries are missing a session header");
  }

  const profileName = options.profile ?? "klein";
  const profileConfig = resolveProfile(profileName);
  const systemPrompt =
    options.systemPromptOverride ??
    (await loadPromptFile(options.systemPromptFile ?? profileConfig.systemPromptFile));
  const skillsDirectory = options.skillsDirectory ?? profileConfig.skillsDirectory;

  const sessionKey = options.sessionKey ?? "discord-channel:inspect";
  const channelId = parseDiscordChannelId(sessionKey) ?? "ch-inspect";
  const ownerFeaturesAllowed = options.ownerFeaturesAllowed ?? false;
  const ownerUserId = options.ownerUserId ?? "owner-inspect";
  const mode: SessionReplayMode = options.mode ?? "turn-start";

  const turns = extractSessionTurns(options.entries);
  const tempRoot = await mkdtemp(join(tmpdir(), "klein-context-inspect-"));
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

  const offlineCapture = !exec.liveReplay
    ? await createOfflineContextCapture({
        runtimeAgentDir: options.runtimeAgentDir,
        captureProviderPayload: options.captureProviderPayload ?? true,
      })
    : undefined;
  const liveCapture = exec.liveReplay
    ? attachLiveRequestCapture(
        exec.modelRuntime ??
          (await createPiModelRuntime(resolve(options.runtimeAgentDir ?? ".runtime/pi"))),
      )
    : undefined;

  const activeRuntime = liveCapture?.modelRuntime ?? offlineCapture!.modelRuntime;
  const captureExtension = liveCapture?.captureExtension ?? offlineCapture!.captureExtension;
  const capturedRequests = liveCapture?.requests ?? offlineCapture!.requests;
  const setNextLabel = liveCapture?.setNextLabel ?? offlineCapture!.setNextLabel;

  try {
    const provider = options.provider ?? "opencode-go";
    const modelId = options.model ?? "deepseek-v4.1-flash";
    const resolvedModel = exec.liveReplay
      ? resolveConfiguredModel(provider, modelId, activeRuntime)
      : resolveSafeOfflineModel(provider, modelId, activeRuntime);

    let sliceEntries: readonly FileEntry[];
    let targetTurn: ExtractedSessionTurn | undefined;
    let trace: RecordedTurnTrace | undefined;

    if (options.preSliced) {
      sliceEntries = options.entries;
      trace = extractTurnTraceFromEntries(options.traceSourceEntries ?? options.entries, {
        targetAssistantEntryId: options.targetAssistantEntryId,
        recordedResponseContent: options.recordedResponseContent,
        assistantTextBeforeCall: options.assistantTextBeforeCall,
      });
    } else {
      if (turns.length === 0) {
        return {
          sessionId: header.id,
          mode,
          turns,
          sentMessages: [],
          replaySteps: [],
          requests: [],
        };
      }
      const rawIndex = options.turnIndex ?? turns.length - 1;
      const normalizedIndex = rawIndex < 0 ? turns.length + rawIndex : rawIndex;
      targetTurn = turns[normalizedIndex];
      if (!targetTurn) {
        throw new Error(
          `Turn index ${rawIndex} is out of range for session with ${turns.length} turns`,
        );
      }

      if (mode === "turn-start") {
        sliceEntries = buildLinearBranchBeforeEntry(options.entries, targetTurn.userEntryId, {
          inclusive: false,
          dropSystemMessages: true,
        }).fileEntries;
      } else {
        const targetAssistantId =
          options.targetAssistantEntryId ??
          targetTurn.discordSendAssistantEntryId ??
          targetTurn.firstAssistantEntryId;
        sliceEntries = targetAssistantId
          ? buildLinearBranchBeforeEntry(options.entries, targetAssistantId, {
              inclusive: false,
              dropSystemMessages: false,
            }).fileEntries
          : buildLinearBranchBeforeEntry(options.entries, targetTurn.userEntryId, {
              inclusive: true,
              dropSystemMessages: false,
            }).fileEntries;
      }

      trace = extractTurnTraceFromEntries(options.traceSourceEntries ?? options.entries, {
        turnIndex: options.targetAssistantEntryId ? undefined : targetTurn.turnIndex,
        targetAssistantEntryId: options.targetAssistantEntryId,
        recordedResponseContent:
          options.recordedResponseContent ?? targetTurn.discordSendContents.at(-1),
        assistantTextBeforeCall: options.assistantTextBeforeCall,
      });
    }

    const sliceRoot = join(tempRoot, "slice");
    const agentDir = join(sliceRoot, "pi");
    const sessionDir = join(agentDir, "sessions", encodeURIComponent(sessionKey));
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ cacheWarming: "off" }),
      "utf8",
    );

    if (options.runtimeAgentDir) {
      await copyOptionalDir(
        join(resolve(options.runtimeAgentDir), "user-memory"),
        join(sliceRoot, "user-memory"),
      );
    }

    const normalizedEntries = normalizeSessionCwd(sliceEntries, process.cwd());
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
        return [`replay-sent-${sentMessages.length}`];
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
      pino({ level: "silent" }),
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
      logger: pino({ level: "silent" }),
      modelRuntime: activeRuntime,
      sessionMode: "resume",
      watchToolCatalog,
      extraExtensions: [captureExtension],
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

    setNextLabel(options.label ?? `${header.id}:${mode}`);

    try {
      if (!createdSession) {
        throw new Error("Failed to capture underlying Pi AgentSession");
      }

      const initialMessageCount = createdSession.messages.length;

      if (mode === "turn-start") {
        const turn = targetTurn ?? turns.at(-1);
        if (!turn) {
          throw new Error("No user turn found to execute in turn-start mode");
        }
        await createdSession.prompt(turn.userText, {
          images: turn.images.length > 0 ? [...turn.images] : undefined,
          source: "rpc",
        });
      } else {
        if (createdSession.agent.state.messages.length === 0) {
          throw new Error("Cannot inspect/replay pre-message snapshot with empty messages");
        }
        if (createdSession.agent.state.messages.at(-1)?.role === "assistant") {
          throw new Error(
            "Cannot inspect/replay pre-message snapshot when the last message is already an assistant message",
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

      const newMessages = createdSession.messages.slice(initialMessageCount);
      const replaySteps = exec.liveReplay
        ? newMessages.map((message) => agentMessageToStep(message))
        : [];
      const lastMessage = createdSession.messages.at(-1);
      const finalAssistantText =
        exec.liveReplay && lastMessage && lastMessage.role === "assistant"
          ? extractAssistantText(lastMessage)
          : undefined;

      return {
        sessionId: header.id,
        mode,
        turns,
        ...(trace ? { trace } : {}),
        sentMessages,
        ...(finalAssistantText ? { finalAssistantText } : {}),
        replaySteps,
        requests: [...capturedRequests],
      };
    } finally {
      agent.dispose();
    }
  } finally {
    offlineCapture?.dispose();
    if (previousAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function createOfflineContextCapture(options: {
  readonly runtimeAgentDir?: string;
  readonly captureProviderPayload: boolean;
}): Promise<{
  readonly modelRuntime: ModelRuntime;
  readonly captureExtension: ExtensionFactory;
  readonly requests: CapturedLlmRequest[];
  setNextLabel(label: string | undefined): void;
  dispose(): void;
}> {
  const tempRoot = mkdtempSync(join(tmpdir(), "klein-offline-capture-"));
  const modelsPath = join(tempRoot, "models.json");
  const modelsStorePath = join(tempRoot, "models-store.json");

  if (options.runtimeAgentDir) {
    const resolvedDir = resolve(options.runtimeAgentDir);
    await copyIfExists(join(resolvedDir, "models.json"), modelsPath);
    await copyIfExists(join(resolvedDir, "models-store.json"), modelsStorePath);
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempRoot, "auth.json"),
    modelsPath,
    modelsStorePath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  for (const provider of ["opencode-go", "opencode", "google", "mistral", "anthropic", "openai"]) {
    await modelRuntime.setRuntimeApiKey(provider, "inspect-dummy-key");
  }

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
    const outer = createAssistantMessageEventStream();
    const capturedContextWithSystem = structuredClone(latestContextWithSystem);
    const capturedTranscriptMessages = structuredClone(context.messages);
    const capturedTools = structuredClone(getCurrentTools(context.messages));
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const systemMessages = structuredClone(
      context.messages.filter((message): message is SystemMessage => message.role === "system"),
    );
    const label = nextLabel;
    nextLabel = undefined;

    void (async () => {
      let providerPayload: unknown;
      if (options.captureProviderPayload && model.provider !== "faux") {
        await modelRuntime.setRuntimeApiKey(model.provider, "inspect-dummy-key");
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
        systemPrompt,
        systemMessages,
        tools: capturedTools,
        contextWithSystem: capturedContextWithSystem,
        transcriptMessages: capturedTranscriptMessages,
        providerPayload,
      });

      const stopMessage = fauxAssistantMessage("(inspection complete)");
      outer.push({ type: "done", reason: "stop", message: stopMessage });
      outer.end(stopMessage);
    })();

    return outer;
  }) as typeof modelRuntime.streamSimple;

  return {
    modelRuntime,
    captureExtension,
    requests,
    setNextLabel(label) {
      nextLabel = label;
    },
    dispose() {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function attachLiveRequestCapture(modelRuntime: ModelRuntime): {
  readonly modelRuntime: ModelRuntime;
  readonly captureExtension: ExtensionFactory;
  readonly requests: CapturedLlmRequest[];
  setNextLabel(label: string | undefined): void;
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
    const capturedTools = structuredClone(getCurrentTools(context.messages));
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const systemMessages = structuredClone(
      context.messages.filter((message): message is SystemMessage => message.role === "system"),
    );
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
        systemPrompt,
        systemMessages,
        tools: capturedTools,
        contextWithSystem: capturedContextWithSystem,
        transcriptMessages: capturedTranscriptMessages,
        providerPayload,
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
    apiKey: streamOptions?.apiKey ?? "inspect-dummy-key",
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
      return undefined;
    }
  }

  return capturedPayload;
}

function resolveSafeOfflineModel(
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

async function copyIfExists(src: string, dest: string): Promise<void> {
  try {
    await copyFile(src, dest);
  } catch {
    // Optional file may not exist.
  }
}

async function copyOptionalDir(src: string, dest: string): Promise<void> {
  try {
    const { cp } = await import("node:fs/promises");
    await cp(src, dest, { recursive: true });
  } catch {
    // Optional directory may not exist.
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
    guildId: "guild-inspect",
    channelName: "inspect",
    occurredAt: "2026-10-14T09:30:00.000Z",
    author: {
      id: "user-inspect",
      username: "user",
      displayName: "User",
      bot: false,
    },
    content: "Placeholder message fetched during local session replay.",
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

function findMatchingContextMeta(
  contextWithSystem: readonly CapturedAgentMessageEntry[],
  message: Message,
  _transcriptIndex: number,
): CapturedAgentMessageEntry | undefined {
  const rendered = renderMessageTextForDisplay(message);
  return contextWithSystem.find(
    (entry) =>
      entry.role !== "system" &&
      (entry.text === rendered ||
        (entry.role === "custom" && message.role === "user" && entry.text === rendered)),
  );
}

function renderMessageTextForDisplay(message: Message): string {
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

function renderCustomContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block && typeof block.text === "string"
          ? block.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    return JSON.stringify(content, null, 2);
  }
  return "";
}

function sessionEntryToStep(entry: SessionEntry): RecordedTurnStep | undefined {
  if (entry.type === "custom") {
    return {
      entryId: entry.id,
      timestamp: entry.timestamp,
      role: "custom",
      customType: entry.customType,
      text: renderCustomContent(entry.data),
      imageCount: 0,
    };
  }
  if (entry.type === "custom_message") {
    return {
      entryId: entry.id,
      timestamp: entry.timestamp,
      role: "custom",
      customType: entry.customType,
      text: renderCustomContent(entry.content),
      imageCount: 0,
    };
  }
  if (entry.type !== "message") return undefined;
  return agentMessageToStep(entry.message, entry.id, entry.timestamp);
}

function agentMessageToStep(
  message: AgentMessage,
  entryId?: string,
  timestamp?: string,
): RecordedTurnStep {
  const customType =
    "customType" in message && typeof message.customType === "string"
      ? message.customType
      : undefined;
  const toolName =
    "toolName" in message && typeof message.toolName === "string" ? message.toolName : undefined;
  const isError =
    "isError" in message && typeof message.isError === "boolean" ? message.isError : undefined;

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  let imageCount = 0;

  if ("content" in message) {
    if (typeof message.content === "string") {
      textParts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (
          block.type === "thinking" &&
          "thinking" in block &&
          typeof block.thinking === "string"
        ) {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall" && "name" in block) {
          toolCalls.push({
            id: "id" in block ? String(block.id) : "",
            name: String(block.name),
            arguments: "arguments" in block ? block.arguments : {},
          });
        } else if (block.type === "image") {
          imageCount += 1;
        }
      }
    }
  }

  return {
    ...(entryId ? { entryId } : {}),
    ...(timestamp ? { timestamp } : {}),
    role: message.role,
    ...(customType ? { customType } : {}),
    ...(toolName ? { toolName } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(thinkingParts.length > 0 ? { thinking: thinkingParts.join("\n") } : {}),
    text: textParts.join("\n"),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
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

function classifyMessageKind(message: Message, customType?: string): string {
  if (customType === TURN_CONTEXT_CUSTOM_TYPE) return "turn-context";
  if (customType === "klein-context-handoff") return "context-handoff";
  if (customType === "klein-image-analysis") return "image-analysis";
  if (customType === "klein-image-analysis-error") return "image-analysis-error";
  if (customType) return `custom:${customType}`;
  if (message.role === "user") {
    const text = renderMessageTextForDisplay(message);
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

function toPreview(text: string, maxLength = 120): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
