import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentEvent, AgentEventContent } from "@agents/core/agent-event";
import type {
  DiscordImageAttachment,
  DiscordMessage,
  DiscordReplyReference,
  DiscordUser,
} from "@modules/discord/domain/discord-message";
import { parseAccessScope, type AccessScope } from "@shared/access";
import {
  isConversationKey,
  isSameConversationKey,
  serializeConversationKey,
  type ConversationKey,
} from "@shared/conversation-key";
import { readJsonRecord } from "@shared/record-file";
import { getErrorCode, isFileNotFound, isRecord } from "@shared/type-guards";

export type InboxItemStatus = "pending" | "claimed" | "done" | "interrupted" | "failed";

export type InboxItemOutcome = "done" | "interrupted" | "failed";

interface InboxItemBase {
  readonly id: string;
  readonly conversationKey: ConversationKey;
  readonly accessScope?: AccessScope;
  readonly enqueuedAt: string;
  readonly status: InboxItemStatus;
  readonly attempts: number;
  readonly claimedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

interface NewInboxItemBase {
  readonly id: string;
  readonly conversationKey: ConversationKey;
  readonly accessScope?: AccessScope;
  readonly enqueuedAt: string;
}

export type InboxItem =
  | (InboxItemBase & { readonly kind: "discord.message"; readonly message: DiscordMessage })
  | (InboxItemBase & { readonly kind: "agent.event"; readonly event: AgentEvent });

export type NewInboxItem =
  | (NewInboxItemBase & { readonly kind: "discord.message"; readonly message: DiscordMessage })
  | (NewInboxItemBase & { readonly kind: "agent.event"; readonly event: AgentEvent });

export interface ConversationInboxStore {
  enqueue(item: NewInboxItem): Promise<boolean>;
  claimNext(conversationKey: ConversationKey): Promise<InboxItem | undefined>;
  finish(item: InboxItem, outcome: InboxItemOutcome, error?: string): Promise<void>;
  recoverClaims(): Promise<number>;
  listPendingConversations(): Promise<readonly ConversationKey[]>;
}

export class ConversationInbox implements ConversationInboxStore {
  private readonly inboxDirectory: string;

  constructor(stateDir: string) {
    this.inboxDirectory = resolve(stateDir, "inbox");
  }

  async enqueue(item: NewInboxItem): Promise<boolean> {
    const targetPath = this.getItemPath(item.conversationKey, item.id);
    await mkdir(this.getConversationDirectory(item.conversationKey), { recursive: true });

    const pending: InboxItem = { ...item, status: "pending", attempts: 0 };
    const temporaryPath = this.getTemporaryPath(targetPath);
    await writeFile(temporaryPath, serializeItem(pending), "utf8");
    try {
      await link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async claimNext(conversationKey: ConversationKey): Promise<InboxItem | undefined> {
    const pending = (await this.readConversation(conversationKey))
      .filter((item) => item.status === "pending")
      .toSorted(compareItems);
    const next = pending[0];
    if (next === undefined) return undefined;

    const claimed: InboxItem = {
      ...next,
      status: "claimed",
      attempts: next.attempts + 1,
      claimedAt: new Date().toISOString(),
    };
    await this.write(claimed);
    return claimed;
  }

  async finish(item: InboxItem, outcome: InboxItemOutcome, error?: string): Promise<void> {
    await this.write({
      ...item,
      status: outcome,
      finishedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    });
  }

  async recoverClaims(): Promise<number> {
    const claimed = (await this.readAll()).filter((item) => item.status === "claimed");
    await Promise.all(
      claimed.map((item) => this.write({ ...item, status: "pending", claimedAt: undefined })),
    );
    return claimed.length;
  }

  async listPendingConversations(): Promise<readonly ConversationKey[]> {
    const conversations = new Map<string, ConversationKey>();
    const items = await this.readAll();
    for (const item of items) {
      if (item.status !== "pending") continue;
      conversations.set(serializeConversationKey(item.conversationKey), item.conversationKey);
    }
    return [...conversations]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, conversationKey]) => conversationKey);
  }

  private async readAll(): Promise<readonly InboxItem[]> {
    const directories = await this.listConversationDirectories();
    const items = await Promise.all(
      directories.map(async (directory) => this.readDirectory(directory)),
    );
    return items.flat();
  }

  private async listConversationDirectories(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.inboxDirectory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(this.inboxDirectory, entry.name));
  }

  private async readDirectory(directory: string): Promise<readonly InboxItem[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readItem(resolve(directory, entry.name))),
    );
    return items.filter((item): item is InboxItem => item !== undefined);
  }

  private async readConversation(conversationKey: ConversationKey): Promise<readonly InboxItem[]> {
    const items = await this.readDirectory(this.getConversationDirectory(conversationKey));
    return items.filter((item) => isSameConversationKey(item.conversationKey, conversationKey));
  }

  private async readItem(path: string): Promise<InboxItem | undefined> {
    return readJsonRecord(path, parseInboxItem);
  }

  private async write(item: InboxItem): Promise<void> {
    const targetPath = this.getItemPath(item.conversationKey, item.id);
    await mkdir(this.getConversationDirectory(item.conversationKey), { recursive: true });
    const temporaryPath = this.getTemporaryPath(targetPath);
    await writeFile(temporaryPath, serializeItem(item), "utf8");
    await rename(temporaryPath, targetPath);
  }

  private getConversationDirectory(conversationKey: ConversationKey): string {
    return resolve(
      this.inboxDirectory,
      encodeURIComponent(serializeConversationKey(conversationKey)),
    );
  }

  private getItemPath(conversationKey: ConversationKey, id: string): string {
    return resolve(
      this.getConversationDirectory(conversationKey),
      `${encodeURIComponent(id)}.json`,
    );
  }

  private getTemporaryPath(targetPath: string): string {
    return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  }
}

function serializeItem(item: InboxItem): string {
  return `${JSON.stringify(item, null, 2)}\n`;
}

function compareItems(left: InboxItem, right: InboxItem): number {
  return left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id);
}

function parseInboxItem(value: unknown): InboxItem {
  if (!isInboxItem(value)) throw new Error("Invalid inbox item");
  return value;
}

function isInboxItem(value: unknown): value is InboxItem {
  if (!isRecord(value)) return false;
  if (!hasInboxItemFields(value)) return false;
  if (value.kind === "discord.message") return isDiscordMessage(value.message);
  if (value.kind === "agent.event") return isAgentEvent(value.event);
  return false;
}

function hasInboxItemFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isConversationKey(value.conversationKey) &&
    (value.accessScope === undefined || parseAccessScope(value.accessScope) !== undefined) &&
    typeof value.enqueuedAt === "string" &&
    value.enqueuedAt.length > 0 &&
    isInboxItemStatus(value.status) &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    (value.claimedAt === undefined || typeof value.claimedAt === "string") &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isInboxItemStatus(value: unknown): value is InboxItemStatus {
  return (
    value === "pending" ||
    value === "claimed" ||
    value === "done" ||
    value === "interrupted" ||
    value === "failed"
  );
}

function isDiscordMessage(value: unknown): value is DiscordMessage {
  return (
    isRecord(value) &&
    typeof value.occurredAt === "string" &&
    typeof value.channelId === "string" &&
    (value.channelName === undefined || typeof value.channelName === "string") &&
    (value.guildId === undefined || typeof value.guildId === "string") &&
    (value.parentChannelId === undefined || typeof value.parentChannelId === "string") &&
    (value.threadId === undefined || typeof value.threadId === "string") &&
    isDiscordUser(value.author) &&
    typeof value.content === "string" &&
    typeof value.id === "string" &&
    Array.isArray(value.images) &&
    value.images.every((image) => isDiscordImageAttachment(image)) &&
    (value.replyTo === undefined || isDiscordReplyReference(value.replyTo))
  );
}

function isDiscordUser(value: unknown): value is DiscordUser {
  return (
    isRecord(value) &&
    typeof value.bot === "boolean" &&
    typeof value.id === "string" &&
    typeof value.username === "string" &&
    typeof value.displayName === "string"
  );
}

function isDiscordImageAttachment(value: unknown): value is DiscordImageAttachment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.filename === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  );
}

function isDiscordReplyReference(value: unknown): value is DiscordReplyReference {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.author === undefined || isDiscordUser(value.author)) &&
    (value.content === undefined || typeof value.content === "string")
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.occurredAt === "string" &&
    typeof value.type === "string" &&
    typeof value.source === "string" &&
    Array.isArray(value.content) &&
    value.content.every((content) => isAgentEventContent(content))
  );
}

function isAgentEventContent(value: unknown): value is AgentEventContent {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") {
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }
  return false;
}
