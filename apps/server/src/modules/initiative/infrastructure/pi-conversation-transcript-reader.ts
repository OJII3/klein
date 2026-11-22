import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { isFileNotFound, isRecord } from "@shared/type-guards";

import type {
  ConversationTranscriptMessage,
  ConversationTranscriptReader,
} from "../ports/conversation-transcript-reader";

export class PiConversationTranscriptReader implements ConversationTranscriptReader {
  constructor(private readonly agentDirectory: string) {}

  async read(input: {
    readonly sessionKey: string;
    readonly limit: number;
    readonly since?: number;
  }): Promise<readonly ConversationTranscriptMessage[]> {
    const directory = resolve(
      this.agentDirectory,
      "sessions",
      "conversation",
      encodeURIComponent(input.sessionKey),
    );
    const sessions = await listSessions(directory);
    const latest = sessions.at(0);
    if (!latest) return [];

    const entries = parseSessionEntries(await readFile(latest.path, "utf8"));
    const messages: ConversationTranscriptMessage[] = [];
    for (const entry of entries) {
      if (entry.type === "session") continue;
      const message = toTranscriptMessage(entry);
      if (!message) continue;
      if (input.since !== undefined && Date.parse(message.timestamp) < input.since) continue;
      messages.push(message);
    }

    return messages.slice(-input.limit);
  }
}

async function listSessions(directory: string) {
  try {
    const sessions = await SessionManager.listAll(directory);
    return sessions.toSorted((left, right) => right.modified.getTime() - left.modified.getTime());
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

function toTranscriptMessage(entry: SessionEntry): ConversationTranscriptMessage | undefined {
  if (entry.type === "custom_message" && entry.customType === "klein-context-handoff") {
    const text = extractText(entry.content);
    if (text.length === 0) return undefined;
    return { id: entry.id, role: "user", text, timestamp: entry.timestamp };
  }
  if (entry.type !== "message") return undefined;
  const { role } = entry.message;
  if (role !== "user" && role !== "assistant") return undefined;
  const text =
    role === "assistant"
      ? extractAssistantText(entry.message.content)
      : extractText(entry.message.content);
  if (text.length === 0) return undefined;
  return { id: entry.id, role, text, timestamp: entry.timestamp };
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (
      block.type === "toolCall" &&
      block.name === "discord_send" &&
      isRecord(block.arguments) &&
      typeof block.arguments.content === "string"
    ) {
      parts.push(block.arguments.content);
    }
  }
  return parts.join("\n").trim();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}
