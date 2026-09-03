import {
  compact,
  findCutPoint,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionContext,
  type ExtensionFactory,
  type FileOperations,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

/** Start preparing a summary this many tokens before Pi's compaction threshold. */
export const BACKGROUND_COMPACTION_LEAD_TOKENS = 16_384;

export interface BackgroundCompactionOptions {
  readonly leadTokens?: number;
  readonly summarize?: BackgroundCompactionSummarizer;
}

export type BackgroundCompactionSummarizer = (
  preparation: BackgroundCompactionPreparation,
  context: ExtensionContext,
  signal: AbortSignal,
) => Promise<CompactionResult | undefined>;

type ContextMessages = ReturnType<typeof sessionEntryToContextMessages>;
type ResolvedCompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]>;

/** Local copy of the preparation shape because Pi does not export that type. */
export interface BackgroundCompactionPreparation {
  readonly firstKeptEntryId: string;
  readonly messagesToSummarize: ContextMessages;
  readonly turnPrefixMessages: ContextMessages;
  readonly isSplitTurn: boolean;
  readonly tokensBefore: number;
  readonly previousSummary?: string;
  readonly fileOps: FileOperations;
  readonly settings: ResolvedCompactionSettings;
}

interface PendingCompaction {
  readonly controller: AbortController;
  readonly firstKeptEntryId: string;
  readonly summarizedEntryIds: readonly string[];
  result?: CompactionResult;
}

interface CompactionState {
  pending?: PendingCompaction;
}

/**
 * Prepare Pi's normal compaction summary while the session is otherwise idle.
 * The actual session mutation is still performed by AgentSession through the
 * session_before_compact hook, keeping Pi's history and lifecycle events intact.
 */
export function createBackgroundCompactionExtension(
  settingsManager: SettingsManager,
  options: BackgroundCompactionOptions = {},
): ExtensionFactory {
  const state: CompactionState = {};
  const leadTokens = options.leadTokens ?? BACKGROUND_COMPACTION_LEAD_TOKENS;
  const summarize =
    options.summarize ??
    ((preparation, context, signal) =>
      summarizeWithPi(preparation, context, signal, settingsManager));

  return (pi) => {
    pi.on("turn_end", (_event, context) => {
      const compactionSettings = settingsManager.getCompactionSettings();
      const contextUsage = context.getContextUsage();
      if (
        !compactionSettings.enabled ||
        !contextUsage ||
        contextUsage.tokens === null ||
        !shouldStartBackgroundCompaction(
          contextUsage.tokens,
          contextUsage.contextWindow,
          compactionSettings.reserveTokens,
          leadTokens,
        )
      ) {
        return;
      }

      const branchEntries = context.sessionManager.getBranch();
      const preparation = prepareBackgroundCompaction(
        branchEntries,
        compactionSettings,
        contextUsage.tokens,
      );
      if (!preparation) return;

      const pending = state.pending;
      if (pending && isCompatible(pending, preparation, branchEntries)) return;
      if (pending) cancelPending(state, pending);

      const controller = new AbortController();
      const nextPending: PendingCompaction = {
        controller,
        firstKeptEntryId: preparation.firstKeptEntryId,
        summarizedEntryIds: entryIdsBefore(branchEntries, preparation.firstKeptEntryId),
      };
      state.pending = nextPending;

      void summarize(preparation, context, controller.signal)
        .then((result) => {
          if (state.pending !== nextPending) return;
          if (
            !result ||
            result.firstKeptEntryId !== nextPending.firstKeptEntryId ||
            controller.signal.aborted
          ) {
            state.pending = undefined;
            return;
          }
          nextPending.result = result;
        })
        .catch((error: unknown) => {
          if (state.pending !== nextPending) return;
          state.pending = undefined;
          if (!controller.signal.aborted) {
            console.error("Pi background compaction failed:", error);
          }
        });
    });

    pi.on("session_before_compact", (event, _context) => {
      const pending = state.pending;
      if (!pending) return;

      if (
        event.customInstructions !== undefined ||
        !pending.result ||
        !isCompatible(pending, event.preparation, event.branchEntries)
      ) {
        cancelPending(state, pending);
        return;
      }

      state.pending = undefined;
      return {
        compaction: {
          ...pending.result,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });

    pi.on("session_shutdown", () => {
      if (state.pending) cancelPending(state, state.pending);
    });
  };
}

export function shouldStartBackgroundCompaction(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
  leadTokens: number = BACKGROUND_COMPACTION_LEAD_TOKENS,
): boolean {
  const startAt = Math.max(0, contextWindow - reserveTokens - leadTokens);
  return contextTokens >= startAt;
}

function isCompatible(
  pending: PendingCompaction,
  preparation: BackgroundCompactionPreparation,
  branchEntries: readonly { id: string }[],
): boolean {
  if (pending.firstKeptEntryId !== preparation.firstKeptEntryId) return false;

  const firstKeptIndex = branchEntries.findIndex(
    (entry) => entry.id === preparation.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) return false;

  const currentSummarizedIds = branchEntries.slice(0, firstKeptIndex).map((entry) => entry.id);
  if (currentSummarizedIds.length !== pending.summarizedEntryIds.length) return false;
  return currentSummarizedIds.every((id, index) => id === pending.summarizedEntryIds[index]);
}

function entryIdsBefore(
  branchEntries: readonly { id: string }[],
  firstKeptEntryId: string,
): readonly string[] {
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  return firstKeptIndex < 0 ? [] : branchEntries.slice(0, firstKeptIndex).map((entry) => entry.id);
}

function cancelPending(state: CompactionState, pending: PendingCompaction): void {
  if (state.pending !== pending) return;
  pending.controller.abort();
  state.pending = undefined;
}

async function summarizeWithPi(
  preparation: BackgroundCompactionPreparation,
  context: ExtensionContext,
  signal: AbortSignal,
  settingsManager: SettingsManager,
): Promise<CompactionResult | undefined> {
  const model = context.model;
  if (!model) return undefined;

  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return compact(
    preparation,
    requestModel,
    auth.apiKey,
    toRequestHeaders(auth.headers),
    undefined,
    signal,
    context.thinkingLevel,
    undefined,
    auth.env,
    settingsManager.getRetrySettings(),
    undefined,
    context.sessionManager.getSessionId(),
  );
}

function prepareBackgroundCompaction(
  branchEntries: SessionEntry[],
  settings: ResolvedCompactionSettings,
  contextTokens: number,
): BackgroundCompactionPreparation | undefined {
  if (branchEntries.at(-1)?.type === "compaction") return undefined;

  const previousCompaction = getLatestCompactionEntry(branchEntries);
  const previousCompactionIndex = previousCompaction
    ? branchEntries.findIndex((entry) => entry.id === previousCompaction.id)
    : -1;
  const previousCompactionBoundary = previousCompaction
    ? branchEntries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId)
    : -1;
  const boundaryStart = previousCompaction
    ? previousCompactionBoundary >= 0
      ? previousCompactionBoundary
      : previousCompactionIndex + 1
    : 0;
  const cutPoint = findCutPoint(
    branchEntries,
    boundaryStart,
    branchEntries.length,
    settings.keepRecentTokens,
  );
  const firstKeptEntry = branchEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry || cutPoint.isSplitTurn) return undefined;

  const messagesToSummarize = branchEntries
    .slice(boundaryStart, cutPoint.firstKeptEntryIndex)
    .flatMap(sessionEntryToContextMessages);
  if (messagesToSummarize.length === 0) return undefined;

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: contextTokens,
    previousSummary: previousCompaction?.summary,
    fileOps: emptyFileOperations(),
    settings,
  };
}

function emptyFileOperations(): FileOperations {
  return {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
}

function toRequestHeaders(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
