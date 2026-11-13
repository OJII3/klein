import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import type { DiscordReactionEvent } from "@modules/discord/domain/discord-reaction";
import { TURN_CONTEXT_CUSTOM_TYPE } from "./pi-turn-context";

export const DEFAULT_NEGATIVE_FEEDBACK_EMOJIS = ["👎"] as const;

export interface SentDiscordMessageRecord {
  readonly discordMessageId: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly assistantEntryId: string;
  readonly toolResultEntryId: string;
  readonly toolCallId: string;
  readonly sentAt: string;
  readonly content: string;
  readonly ownerFeaturesAllowed: boolean;
}

export interface EvalFeedbackCase {
  readonly version: 1;
  readonly caseId: string;
  readonly createdAt: string;
  readonly sessionFile: string;
  readonly reaction: {
    readonly emoji: string;
    readonly userId: string;
    readonly isOwner: boolean;
    readonly channelId: string;
    readonly guildId?: string;
    readonly messageId: string;
    readonly occurredAt: string;
  };
  readonly sourceSession: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly ownerFeaturesAllowed: boolean;
    readonly originalSessionFile?: string;
  };
  readonly slice: {
    readonly upToEntryId: string | null;
    readonly targetAssistantEntryId: string;
    readonly targetToolResultEntryId: string;
    readonly turnStartEntryId?: string;
    readonly turnContextEntryId?: string;
    readonly entryCount: number;
  };
  readonly recordedResponse: {
    readonly content: string;
    readonly toolCallId: string;
    readonly assistantTextBeforeCall?: string;
  };
}

export interface LoadedEvalFeedbackCase {
  readonly caseMeta: EvalFeedbackCase;
  readonly entries: readonly FileEntry[];
  readonly caseFilePath: string;
  readonly sessionFilePath: string;
}

export function isMatchingReactionEmoji(
  emoji: string,
  allowedEmojis: readonly string[] = DEFAULT_NEGATIVE_FEEDBACK_EMOJIS,
): boolean {
  const normalized = emoji.trim();
  return allowedEmojis.some(
    (candidate) => normalized === candidate || normalized.startsWith(candidate),
  );
}

export function buildLinearBranchBeforeEntry(
  entries: readonly FileEntry[],
  targetEntryId: string,
  options: {
    readonly inclusive?: boolean;
    readonly dropSystemMessages?: boolean;
  } = {},
): {
  readonly header: SessionHeader;
  readonly branchEntries: readonly SessionEntry[];
  readonly fileEntries: readonly FileEntry[];
} {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  if (!header) {
    throw new Error("Session entries are missing a session header");
  }

  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const byId = new Map<string, SessionEntry>();
  for (const entry of sessionEntries) {
    byId.set(entry.id, entry);
  }

  const targetEntry = byId.get(targetEntryId);
  if (!targetEntry) {
    throw new Error(`Target entry not found in session: ${targetEntryId}`);
  }

  const startId = options.inclusive ? targetEntry.id : targetEntry.parentId;
  const collected: SessionEntry[] = [];
  const visited = new Set<string>();
  let cursorId = startId;

  while (cursorId) {
    if (visited.has(cursorId)) {
      throw new Error(`Cycle detected in session entries at: ${cursorId}`);
    }
    visited.add(cursorId);
    const entry = byId.get(cursorId);
    if (!entry) break;
    collected.push(entry);
    cursorId = entry.parentId;
  }

  collected.reverse();

  const filtered: SessionEntry[] = [];
  if (options.dropSystemMessages) {
    const isDroppedSystem = (entry: SessionEntry): boolean =>
      entry.type === "message" && entry.message.role === "system";
    const collectedIndexById = new Map(collected.map((entry, index) => [entry.id, index]));

    for (const entry of collected) {
      if (isDroppedSystem(entry)) continue;
      if (entry.type === "compaction") {
        let nextFirstKeptId = entry.firstKeptEntryId;
        const originalIdx = collectedIndexById.get(entry.firstKeptEntryId);
        if (originalIdx !== undefined && isDroppedSystem(collected[originalIdx]!)) {
          const replacement = collected
            .slice(originalIdx + 1)
            .find((candidate) => !isDroppedSystem(candidate));
          nextFirstKeptId = replacement?.id ?? entry.id;
        }
        const { systemMessage: _droppedSystemMessage, ...rest } = entry;
        filtered.push(
          nextFirstKeptId === entry.firstKeptEntryId
            ? rest
            : { ...rest, firstKeptEntryId: nextFirstKeptId },
        );
      } else {
        filtered.push(entry);
      }
    }
  } else {
    filtered.push(...collected);
  }

  const relinked = filtered.map((entry, index): SessionEntry => {
    const parentId = index === 0 ? null : filtered[index - 1]!.id;
    return entry.parentId === parentId ? entry : { ...entry, parentId };
  });

  return {
    header,
    branchEntries: relinked,
    fileEntries: [header, ...relinked],
  };
}

export function findTurnBoundsForAssistantEntry(
  entries: readonly FileEntry[],
  assistantEntryId: string,
): {
  readonly turnStartEntryId?: string;
  readonly turnContextEntryId?: string;
  readonly assistantTextBeforeCall?: string;
  readonly discordSendContent?: string;
} {
  const { branchEntries } = buildLinearBranchBeforeEntry(entries, assistantEntryId, {
    inclusive: true,
  });

  const targetEntry = branchEntries.at(-1);
  let assistantTextBeforeCall: string | undefined;
  let discordSendContent: string | undefined;
  if (targetEntry?.type === "message" && targetEntry.message.role === "assistant") {
    const textBlocks: string[] = [];
    for (const block of targetEntry.message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        textBlocks.push(block.text.trim());
      } else if (
        block.type === "toolCall" &&
        block.name === "discord_send" &&
        typeof block.arguments?.content === "string"
      ) {
        discordSendContent = block.arguments.content;
      }
    }
    if (textBlocks.length > 0) {
      assistantTextBeforeCall = textBlocks.join("\n");
    }
  }

  let turnStartEntryId: string | undefined;
  for (let i = branchEntries.length - 2; i >= 0; i -= 1) {
    const entry = branchEntries[i]!;
    if (entry.type === "message" && entry.message.role === "user") {
      turnStartEntryId = entry.id;
      break;
    }
  }

  let turnContextEntryId: string | undefined;
  if (turnStartEntryId) {
    const userIndex = branchEntries.findIndex((entry) => entry.id === turnStartEntryId);
    for (let i = userIndex - 1; i >= 0; i -= 1) {
      const entry = branchEntries[i]!;
      if (entry.type === "custom" && entry.customType === TURN_CONTEXT_CUSTOM_TYPE) {
        turnContextEntryId = entry.id;
        break;
      }
    }
  }

  return {
    turnStartEntryId,
    turnContextEntryId,
    assistantTextBeforeCall,
    discordSendContent,
  };
}

export function serializeSessionEntriesToJsonl(entries: readonly FileEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export class SentMessageSessionIndex {
  private readonly filePath: string;
  private readonly byMessageId = new Map<string, SentDiscordMessageRecord>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(agentDir: string, filePath?: string) {
    this.filePath = filePath ?? join(resolve(agentDir), "eval", "sent-messages.jsonl");
  }

  get path(): string {
    return this.filePath;
  }

  async record(entry: SentDiscordMessageRecord): Promise<void> {
    this.byMessageId.set(entry.discordMessageId, entry);
    const work = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
    this.writeQueue = work.catch(() => undefined);
    await work;
  }

  async findByDiscordMessageId(
    discordMessageId: string,
  ): Promise<SentDiscordMessageRecord | undefined> {
    await this.writeQueue;
    const cached = this.byMessageId.get(discordMessageId);
    if (cached) return cached;

    if (!this.loaded) {
      await this.loadFromDisk();
      return this.byMessageId.get(discordMessageId);
    }

    // Re-read in case another process appended while running.
    await this.loadFromDisk();
    return this.byMessageId.get(discordMessageId);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async loadFromDisk(): Promise<void> {
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as SentDiscordMessageRecord;
        if (parsed && typeof parsed.discordMessageId === "string") {
          this.byMessageId.set(parsed.discordMessageId, parsed);
        }
      } catch {
        // Ignore malformed trailing lines.
      }
    }
  }
}

export class SessionEvalCaseStore {
  private readonly agentDir: string;
  private readonly casesDir: string;
  private readonly index: SentMessageSessionIndex;

  constructor(options: {
    readonly agentDir: string;
    readonly casesDir?: string;
    readonly index?: SentMessageSessionIndex;
  }) {
    this.agentDir = resolve(options.agentDir);
    this.casesDir = options.casesDir ?? join(this.agentDir, "eval", "cases");
    this.index = options.index ?? new SentMessageSessionIndex(this.agentDir);
  }

  get directory(): string {
    return this.casesDir;
  }

  async recordReactionFeedback(
    reaction: DiscordReactionEvent,
    options: {
      readonly ownerUserId?: string;
      readonly allowedEmojis?: readonly string[];
    } = {},
  ): Promise<EvalFeedbackCase | undefined> {
    if (!isMatchingReactionEmoji(reaction.emoji, options.allowedEmojis)) {
      return undefined;
    }

    const existing = await this.findExistingCase(reaction.messageId, reaction.emoji);
    if (existing) return existing;

    const record = await this.index.findByDiscordMessageId(reaction.messageId);
    if (!record) return undefined;

    const sessionFilePath = await this.resolveSessionFile(record);
    if (!sessionFilePath) return undefined;

    const rawSession = await readFile(sessionFilePath, "utf8");
    const entries = parseSessionEntries(rawSession);
    const { branchEntries, fileEntries } = buildLinearBranchBeforeEntry(
      entries,
      record.assistantEntryId,
      { inclusive: false },
    );
    const bounds = findTurnBoundsForAssistantEntry(entries, record.assistantEntryId);

    await mkdir(this.casesDir, { recursive: true });
    const safeTimestamp = reaction.occurredAt.replace(/[:.]/g, "-");
    const caseId = `${safeTimestamp}_${reaction.messageId}`;
    const sessionFileName = `${caseId}.session.jsonl`;
    const caseFileName = `${caseId}.case.json`;

    const caseMeta: EvalFeedbackCase = {
      version: 1,
      caseId,
      createdAt: new Date().toISOString(),
      sessionFile: sessionFileName,
      reaction: {
        emoji: reaction.emoji,
        userId: reaction.userId,
        isOwner: Boolean(options.ownerUserId && reaction.userId === options.ownerUserId),
        channelId: reaction.channelId,
        ...(reaction.guildId ? { guildId: reaction.guildId } : {}),
        messageId: reaction.messageId,
        occurredAt: reaction.occurredAt,
      },
      sourceSession: {
        sessionId: record.sessionId,
        sessionKey: record.sessionKey,
        ownerFeaturesAllowed: record.ownerFeaturesAllowed,
        originalSessionFile: sessionFilePath,
      },
      slice: {
        upToEntryId: branchEntries.at(-1)?.id ?? null,
        targetAssistantEntryId: record.assistantEntryId,
        targetToolResultEntryId: record.toolResultEntryId,
        ...(bounds.turnStartEntryId ? { turnStartEntryId: bounds.turnStartEntryId } : {}),
        ...(bounds.turnContextEntryId ? { turnContextEntryId: bounds.turnContextEntryId } : {}),
        entryCount: branchEntries.length,
      },
      recordedResponse: {
        content: record.content || bounds.discordSendContent || reaction.messageContent || "",
        toolCallId: record.toolCallId,
        ...(bounds.assistantTextBeforeCall
          ? { assistantTextBeforeCall: bounds.assistantTextBeforeCall }
          : {}),
      },
    };

    await writeFile(
      join(this.casesDir, sessionFileName),
      serializeSessionEntriesToJsonl(fileEntries),
      "utf8",
    );
    await writeFile(
      join(this.casesDir, caseFileName),
      `${JSON.stringify(caseMeta, null, 2)}\n`,
      "utf8",
    );

    return caseMeta;
  }

  async listCases(): Promise<readonly EvalFeedbackCase[]> {
    let filenames: string[];
    try {
      filenames = await readdir(this.casesDir);
    } catch {
      return [];
    }

    const cases: EvalFeedbackCase[] = [];
    for (const filename of filenames) {
      if (!filename.endsWith(".case.json")) continue;
      try {
        const raw = await readFile(join(this.casesDir, filename), "utf8");
        const parsed = JSON.parse(raw) as EvalFeedbackCase;
        if (parsed && typeof parsed.caseId === "string") {
          cases.push(parsed);
        }
      } catch {
        // Ignore malformed case files.
      }
    }

    return cases.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.caseId.localeCompare(a.caseId),
    );
  }

  async loadCase(caseIdOrPath: string): Promise<LoadedEvalFeedbackCase | undefined> {
    const candidatePath =
      isAbsolute(caseIdOrPath) || caseIdOrPath.includes("/")
        ? resolve(caseIdOrPath)
        : join(
            this.casesDir,
            caseIdOrPath.endsWith(".case.json") ? caseIdOrPath : `${caseIdOrPath}.case.json`,
          );

    let caseFilePath = candidatePath;
    let raw: string | undefined;
    try {
      raw = await readFile(caseFilePath, "utf8");
    } catch {
      const all = await this.listCases();
      const matched = all.find(
        (entry) =>
          entry.caseId === caseIdOrPath ||
          entry.reaction.messageId === caseIdOrPath ||
          basename(entry.sessionFile, ".session.jsonl") === caseIdOrPath,
      );
      if (!matched) return undefined;
      caseFilePath = join(this.casesDir, `${matched.caseId}.case.json`);
      raw = await readFile(caseFilePath, "utf8");
    }

    const caseMeta = JSON.parse(raw) as EvalFeedbackCase;
    const sessionFilePath = join(dirname(caseFilePath), caseMeta.sessionFile);
    const entries = parseSessionEntries(await readFile(sessionFilePath, "utf8"));
    return {
      caseMeta,
      entries,
      caseFilePath,
      sessionFilePath,
    };
  }

  private async findExistingCase(
    messageId: string,
    emoji: string,
  ): Promise<EvalFeedbackCase | undefined> {
    const existing = await this.listCases();
    return existing.find(
      (entry) => entry.reaction.messageId === messageId && entry.reaction.emoji === emoji,
    );
  }

  private async resolveSessionFile(record: SentDiscordMessageRecord): Promise<string | undefined> {
    if (record.sessionFile) {
      try {
        await readFile(record.sessionFile, "utf8");
        return record.sessionFile;
      } catch {
        // Fall back to searching sessions directory by sessionId.
      }
    }

    const sessionsRoot = join(this.agentDir, "sessions");
    let dirs: string[];
    try {
      dirs = await readdir(sessionsRoot);
    } catch {
      return undefined;
    }

    for (const dir of dirs) {
      const dirPath = join(sessionsRoot, dir);
      let files: string[];
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        if (file.includes(record.sessionId)) {
          return join(dirPath, file);
        }
      }
    }

    return undefined;
  }
}
