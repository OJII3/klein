import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

import type {
  PiViewerEvent,
  PiViewerEventKind,
  ViewerSessionSummary,
} from "../domain/viewer-event";

const FIRST_MESSAGE_MAX_LENGTH = 240;
const EVENT_SUMMARY_MAX_LENGTH = 500;

export function toViewerSessionSummary(
  info: SessionInfo,
  channelKey: string,
): ViewerSessionSummary {
  return {
    id: info.id,
    channelKey,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: truncate(info.firstMessage, FIRST_MESSAGE_MAX_LENGTH),
  };
}

export function toViewerEvent(entry: SessionEntry, sessionId: string): PiViewerEvent {
  const base = {
    source: "pi" as const,
    id: entry.id,
    timestamp: entry.timestamp,
    sessionId,
    kind: entry.type as PiViewerEventKind,
    parentId: entry.parentId,
  };

  switch (entry.type) {
    case "message": {
      const content = "content" in entry.message ? entry.message.content : undefined;
      const errorMessage =
        "errorMessage" in entry.message && typeof entry.message.errorMessage === "string"
          ? entry.message.errorMessage
          : undefined;
      return {
        ...base,
        role: entry.message.role,
        summary: truncate(
          errorMessage ? `Error: ${errorMessage}` : extractText(content),
          EVENT_SUMMARY_MAX_LENGTH,
        ),
        errorMessage,
        content: sanitizeContent(content),
      };
    }
    case "thinking_level_change":
      return { ...base, summary: entry.thinkingLevel, content: entry.thinkingLevel };
    case "model_change":
      return {
        ...base,
        summary: `${entry.provider}/${entry.modelId}`,
        content: { provider: entry.provider, modelId: entry.modelId },
      };
    case "usage":
      return {
        ...base,
        summary: entry.note ?? entry.kind,
        content: {
          kind: entry.kind,
          provider: entry.provider,
          model: entry.model,
          usage: entry.usage,
          note: entry.note,
        },
      };
    case "compaction":
      return {
        ...base,
        summary: truncate(entry.summary, EVENT_SUMMARY_MAX_LENGTH),
        content: entry.summary,
      };
    case "branch_summary":
      return {
        ...base,
        summary: truncate(entry.summary, EVENT_SUMMARY_MAX_LENGTH),
        content: entry.summary,
      };
    case "custom":
      return {
        ...base,
        summary: entry.customType,
        content: { customType: entry.customType, data: sanitizeContent(entry.data) },
      };
    case "custom_message":
      return {
        ...base,
        summary: entry.customType,
        content: sanitizeContent(entry.content),
      };
    case "context_edit":
      return {
        ...base,
        summary: entry.targetId,
        content: { targetId: entry.targetId, replacement: sanitizeContent(entry.replacement) },
      };
    case "label":
      return {
        ...base,
        summary: entry.label ?? "",
        content: { targetId: entry.targetId, label: entry.label },
      };
    case "session_info":
      return { ...base, summary: entry.name ?? "", content: entry.name };
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(isRecord)
    .filter((block) => block.type === "text" || block.type === "thinking")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function sanitizeContent(content: unknown): unknown {
  if (Array.isArray(content)) return content.map((item) => sanitizeContent(item));
  if (!isRecord(content)) return content;

  if (content.type === "image" && "data" in content) {
    const { data: _data, ...withoutImageData } = content;
    return { ...withoutImageData, omitted: true };
  }

  return Object.fromEntries(
    Object.entries(content).map(([key, value]) => [key, sanitizeContent(value)]),
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
