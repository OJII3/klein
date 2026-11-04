import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import { renderMemoryContext } from "@modules/memory/infrastructure/memory-context-renderer";
import type {
  MemoryDocument,
  MemoryEntryScope,
  MemoryMessage,
  MemoryOperation,
  MemoryProcessor,
} from "@modules/memory/domain/memory";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export const MEMORY_PROCESSING_SYSTEM_PROMPT = `You are Klein's background guild-memory curator.
Review a batch of Discord messages and the current guild memory, then return only a JSON object.

Keep information that will be useful later: stable facts about the guild, explicit rules, decisions, and procedures. Skip one-off chatter, greetings, unresolved speculation, and information that is not useful beyond this batch. Do not invent facts.

Every entry has a scope that controls where it can be recalled:
- "guild": visible in every channel of this guild. Use this for stable facts, rules, and decisions that apply server-wide.
- "channel": visible only in that channel and its threads. This is the default for local context.
- "thread": visible only in that thread. Use this only for details that matter within a single thread.

Default to "channel" when unsure. Do not use "guild" for something that only matters in one conversation, and do not use "thread" for knowledge that should survive the thread.

Use these operations:
- add: create a new memory entry.
- update: replace an existing entry by its exact id. You may also change its scope.
- delete: remove an existing entry by its exact id.
- noop: make no changes.

The JSON shape is:
{
  "operations": [
    { "type": "add", "scope": { "type": "guild" } | { "type": "channel", "channelId": "id" } | { "type": "thread", "channelId": "id", "threadId": "id" }, "kind": "fact|rule|decision|procedure|temporary", "title": "short title", "content": "memory content" },
    { "type": "update", "id": "existing id", "scope": { "type": "guild" } | { "type": "channel", "channelId": "id" } | { "type": "thread", "channelId": "id", "threadId": "id" }, "kind": "fact|rule|decision|procedure|temporary", "title": "short title", "content": "replacement content" },
    { "type": "delete", "id": "existing id" },
    { "type": "noop" }
  ]
}

Use only the channel and thread ids listed under "Available scopes". For a message inside a thread, use the parent channel id for channel scope.

Return no Markdown fences, explanation, or other text outside the JSON object.`;

export class PiMemoryProcessor implements MemoryProcessor {
  constructor(
    private readonly model: Model<Api>,
    private readonly thinkingLevel?: ThinkingLevel,
    private readonly complete: CompleteSimple = completeSimple,
  ) {}

  async process(
    document: MemoryDocument,
    messages: readonly MemoryMessage[],
  ): Promise<readonly MemoryOperation[]> {
    const response = await this.complete(
      this.model,
      {
        systemPrompt: MEMORY_PROCESSING_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserPrompt(document, messages),
            timestamp: Date.now(),
          },
        ],
      },
      this.thinkingLevel && this.thinkingLevel !== "off"
        ? { reasoning: this.thinkingLevel, maxTokens: 4_000 }
        : { maxTokens: 4_000 },
    );

    return parseMemoryOperations(extractResponseText(response), messages, document);
  }
}

function buildUserPrompt(document: MemoryDocument, messages: readonly MemoryMessage[]): string {
  const currentMemory = renderMemoryContext(document, { includeIds: true }).trim();
  const messageBatch = messages
    .map(
      (message) =>
        `[message id=${message.id} channel=${message.channelId} parent=${
          message.parentChannelId ?? "-"
        } thread=${message.threadId ?? "-"}]\n${message.content}\n[/message]`,
    )
    .join("\n\n");
  const scopeLines = describeAvailableScopes(messages);

  return `Current guild memory:
<memory>
${currentMemory || "(empty)"}
</memory>

Available scopes:
<scopes>
${scopeLines || "(none)"}
</scopes>

New Discord messages:
<messages>
${messageBatch || "(empty)"}
</messages>`;
}

interface ScopeCatalog {
  readonly channelIds: ReadonlySet<string>;
  readonly threadChannels: ReadonlyMap<string, string>;
}

function createScopeCatalog(messages: readonly MemoryMessage[]): ScopeCatalog {
  const channelIds = new Set<string>();
  const threadChannels = new Map<string, string>();

  for (const message of messages) {
    const channelId = message.parentChannelId ?? message.channelId;
    channelIds.add(channelId);
    if (message.threadId) threadChannels.set(message.threadId, channelId);
  }

  return { channelIds, threadChannels };
}

function describeAvailableScopes(messages: readonly MemoryMessage[]): string {
  const catalog = createScopeCatalog(messages);
  return [
    "- guild",
    ...[...catalog.channelIds].map((channelId) => `- channel: ${channelId}`),
    ...[...catalog.threadChannels].map(
      ([threadId, channelId]) => `- thread: ${threadId} (channel: ${channelId})`,
    ),
  ].join("\n");
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

function parseMemoryOperations(
  text: string,
  messages: readonly MemoryMessage[],
  document: MemoryDocument,
): readonly MemoryOperation[] {
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

  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) {
    throw new Error("Memory processing returned an invalid operation list");
  }

  const catalog = createScopeCatalog(messages);
  const existingScopes = new Map(document.entries.map((entry) => [entry.id, entry.scope]));
  return parsed.operations.map((operation) =>
    parseMemoryOperation(operation, catalog, existingScopes),
  );
}

function parseMemoryOperation(
  value: unknown,
  catalog: ScopeCatalog,
  existingScopes: ReadonlyMap<string, MemoryEntryScope>,
): MemoryOperation {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Memory processing returned an invalid operation");
  }

  if (value.type === "noop") return { type: "noop" };

  if (value.type === "delete") {
    return { id: requiredString(value.id, "delete.id"), type: "delete" };
  }

  if (value.type === "add" || value.type === "update") {
    const content = requiredString(value.content, `${value.type}.content`);
    const kind = parseKind(value.kind, `${value.type}.kind`);
    const title = requiredString(value.title, `${value.type}.title`);

    if (value.type === "add") {
      const scope = parseEntryScope(value.scope, "add.scope", catalog);
      return { content, kind, scope, title, type: "add" };
    }

    const id = requiredString(value.id, "update.id");
    const scope = parseEntryScope(value.scope, "update.scope", catalog, existingScopes.get(id));
    return { content, id, kind, scope, title, type: "update" };
  }

  throw new Error(`Memory processing returned an unsupported operation: ${value.type}`);
}

function parseEntryScope(
  value: unknown,
  field: string,
  catalog: ScopeCatalog,
  existingScope?: MemoryEntryScope,
): MemoryEntryScope {
  const scope = parseScopeShape(value, field);
  if (existingScope && sameScope(scope, existingScope)) return scope;

  if (scope.type === "channel" && !catalog.channelIds.has(scope.channelId)) {
    throw new Error(`Memory processing returned an unknown channel: ${scope.channelId}`);
  }
  if (scope.type === "thread" && catalog.threadChannels.get(scope.threadId) !== scope.channelId) {
    throw new Error(`Memory processing returned an unknown thread: ${scope.threadId}`);
  }

  return scope;
}

function parseScopeShape(value: unknown, field: string): MemoryEntryScope {
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

function sameScope(left: MemoryEntryScope, right: MemoryEntryScope): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "channel" && right.type === "channel") {
    return left.channelId === right.channelId;
  }
  if (left.type === "thread" && right.type === "thread") {
    return left.channelId === right.channelId && left.threadId === right.threadId;
  }
  return true;
}

function parseKind(
  value: unknown,
  field: string,
): "fact" | "rule" | "decision" | "procedure" | "temporary" {
  if (
    value === "fact" ||
    value === "rule" ||
    value === "decision" ||
    value === "procedure" ||
    value === "temporary"
  ) {
    return value;
  }

  throw new Error(`Memory processing returned an invalid ${field}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Memory processing returned an invalid ${field}`);
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
