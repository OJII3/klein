import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import { renderMemoryDocument } from "@modules/memory/infrastructure/markdown-memory-store";
import type {
  MemoryDocument,
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

Keep information that will be useful across channels later: stable facts about the guild, explicit rules, decisions, and procedures. Skip one-off chatter, greetings, unresolved speculation, and information that is not useful beyond this batch. Do not invent facts.

Use these operations:
- add: create a new memory entry.
- update: replace an existing entry by its exact id.
- delete: remove an existing entry by its exact id.
- noop: make no changes.

The JSON shape is:
{
  "operations": [
    { "type": "add", "kind": "fact|rule|decision|procedure|temporary", "title": "short title", "content": "memory content" },
    { "type": "update", "id": "existing id", "kind": "fact|rule|decision|procedure|temporary", "title": "short title", "content": "replacement content" },
    { "type": "delete", "id": "existing id" },
    { "type": "noop" }
  ]
}

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

    return parseMemoryOperations(extractResponseText(response));
  }
}

function buildUserPrompt(document: MemoryDocument, messages: readonly MemoryMessage[]): string {
  const currentMemory = renderMemoryDocument(document).trim();
  const messageBatch = messages
    .map(
      (message) =>
        `[message id=${message.id} channel=${message.channelId}]\n${message.content}\n[/message]`,
    )
    .join("\n\n");

  return `Current guild memory:
<memory>
${currentMemory || "(empty)"}
</memory>

New Discord messages:
<messages>
${messageBatch || "(empty)"}
</messages>`;
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

function parseMemoryOperations(text: string): readonly MemoryOperation[] {
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

  return parsed.operations.map(parseMemoryOperation);
}

function parseMemoryOperation(value: unknown): MemoryOperation {
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

    if (value.type === "add") return { content, kind, title, type: "add" };
    return { content, id: requiredString(value.id, "update.id"), kind, title, type: "update" };
  }

  throw new Error(`Memory processing returned an unsupported operation: ${value.type}`);
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
