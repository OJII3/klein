import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import { renderGuildMemoryContext } from "@modules/memory/domain/guild-memory-context-renderer";
import {
  guildMemoryScopeKey,
  type GuildMemoryMessage,
  type GuildMemoryScope,
  type GuildMemoryScopeState,
  type GuildMemoryUpdate,
} from "@modules/memory/domain/guild-memory";
import type { MemoryProcessor } from "@modules/memory/ports/memory-processor";
import type { CompleteSimple } from "./pi-standalone-session-runner";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export const MEMORY_PROCESSING_SYSTEM_PROMPT = `You are Klein's background guild-memory curator.
Review a batch of Discord messages and the current memory for each scope, then return only a JSON object.

Keep durable information that will be useful later. Skip one-off chatter, greetings, unresolved speculation, and details that do not matter beyond this batch. Do not invent facts.

Write each memory as one short standalone line. Include a date in the line only when the date matters. Do not add ids, kinds, timestamps, or source references to individual memories.

Every scope controls where its memory is recalled:
- "guild": visible in every channel of this guild. Use this for stable facts and preferences that apply server-wide.
- "channel": visible in that channel and its threads. This is the default for local context.
- "thread": visible only in that thread. Use this only for details that matter within a single thread.

Default to "channel" when unsure. Do not use "guild" for something that only matters in one conversation, and do not use "thread" for knowledge that should survive the thread.

Use only the scopes listed under "Available scopes". For a message inside a thread, use the parent channel id for channel scope.

For every scope you change, return the complete final lists, merging the still-useful current items and removing duplicates or outdated items. Omit scopes that need no change. Use an empty array for a section with no items.

The two sections are:
- "facts": objective facts about the guild, its channels, people, projects, decisions, and procedures.
- "preferences": tastes, opinions, tone, style choices, and preferred ways of doing things.

The JSON shape is:
{
  "updates": [
    {
      "scope": { "type": "guild" } | { "type": "channel", "channelId": "id" } | { "type": "thread", "channelId": "id", "threadId": "id" },
      "facts": ["standalone fact", "..."],
      "preferences": ["standalone preference", "..."]
    }
  ]
}

Return no Markdown fences, explanation, or other text outside the JSON object.`;

export class PiMemoryProcessor implements MemoryProcessor {
  constructor(
    private readonly model: Model<Api>,
    private readonly thinkingLevel: ThinkingLevel | undefined,
    private readonly complete: CompleteSimple,
  ) {}

  async process(
    scopes: readonly GuildMemoryScopeState[],
    messages: readonly GuildMemoryMessage[],
  ): Promise<readonly GuildMemoryUpdate[]> {
    const response = await this.complete(
      this.model,
      {
        systemPrompt: MEMORY_PROCESSING_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserPrompt(scopes, messages),
            timestamp: Date.now(),
          },
        ],
      },
      this.thinkingLevel && this.thinkingLevel !== "off"
        ? { reasoning: this.thinkingLevel, maxTokens: 4_000 }
        : { maxTokens: 4_000 },
    );

    return parseMemoryUpdates(extractResponseText(response), scopes);
  }
}

function buildUserPrompt(
  scopes: readonly GuildMemoryScopeState[],
  messages: readonly GuildMemoryMessage[],
): string {
  const currentMemory = renderGuildMemoryContext(scopes)?.trim();
  const messageBatch = messages
    .map(
      (message) =>
        `[channel=${message.channelId} parent=${
          message.parentChannelId ?? "-"
        } thread=${message.threadId ?? "-"}]\n${message.content}\n[/message]`,
    )
    .join("\n\n");

  return `Current memory:
<memory>
${currentMemory || "(empty)"}
</memory>

Available scopes:
<scopes>
${scopes.map(({ scope }) => `- ${describeScope(scope)}`).join("\n")}
</scopes>

New Discord messages:
<messages>
${messageBatch || "(empty)"}
</messages>`;
}

function describeScope(scope: GuildMemoryScope): string {
  switch (scope.type) {
    case "guild":
      return "guild";
    case "channel":
      return `channel: ${scope.channelId}`;
    case "thread":
      return `thread: ${scope.threadId} (channel: ${scope.channelId})`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unsupported guild memory scope: ${String(exhaustive)}`);
    }
  }
}

function extractResponseText(response: AssistantMessage): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Memory processing failed: ${response.errorMessage ?? response.stopReason}`);
  }

  const text = response.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Memory processing returned no text");
  return text;
}

function parseMemoryUpdates(
  text: string,
  scopes: readonly GuildMemoryScopeState[],
): readonly GuildMemoryUpdate[] {
  const jsonText = text
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error("Memory processing returned invalid JSON", { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.updates)) {
    throw new Error("Memory processing returned an invalid update list");
  }

  const knownScopes = new Set(scopes.map(({ scope }) => guildMemoryScopeKey(scope)));
  const updatedScopes = new Set<string>();

  return parsed.updates.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Memory processing returned an invalid update");
    }

    const scope = parseScopeShape(value.scope, "update.scope");
    const key = guildMemoryScopeKey(scope);
    if (!knownScopes.has(key)) {
      throw new Error(`Memory processing returned an unknown scope: ${key}`);
    }
    if (updatedScopes.has(key)) {
      throw new Error(`Memory processing returned a duplicate scope: ${key}`);
    }
    updatedScopes.add(key);

    return {
      memory: {
        facts: parseItems(value.facts, "update.facts"),
        preferences: parseItems(value.preferences, "update.preferences"),
      },
      scope,
    };
  });
}

function parseScopeShape(value: unknown, field: string): GuildMemoryScope {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Memory processing returned an invalid ${field}`);
  }

  if (value.type === "guild") return { type: "guild" };

  if (value.type === "channel") {
    return { channelId: requiredString(value.channelId, `${field}.channelId`), type: "channel" };
  }

  if (value.type === "thread") {
    return {
      channelId: requiredString(value.channelId, `${field}.channelId`),
      threadId: requiredString(value.threadId, `${field}.threadId`),
      type: "thread",
    };
  }

  throw new Error(`Memory processing returned an invalid ${field}`);
}

function parseItems(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Memory processing returned an invalid ${field}`);
  }

  return unique(
    value.map((item, index) => {
      const text = requiredString(item, `${field}[${index}]`)
        .replace(/^[-*+]\s+/u, "")
        .trim();
      if (!text) throw new Error(`Memory processing returned an invalid ${field}[${index}]`);
      return text;
    }),
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Memory processing returned an invalid ${field}`);
  }

  return value.replaceAll(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
