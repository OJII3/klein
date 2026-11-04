import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredModel } from "./pi-model-runtime";
import { MEMORY_PROCESSING_SYSTEM_PROMPT, PiMemoryProcessor } from "./pi-memory-processor";

test("asks the configured model for structured memory operations", async () => {
  let received:
    | {
        readonly content: unknown;
        readonly modelId: string;
        readonly reasoning?: string;
        readonly systemPrompt?: string;
      }
    | undefined;
  const processor = new PiMemoryProcessor(
    resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash"),
    "low",
    async (model, context, options) => {
      received = {
        content: context.messages[0]?.content,
        modelId: model.id,
        reasoning: options?.reasoning,
        systemPrompt: context.systemPrompt,
      };
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              operations: [
                {
                  content: "このギルドでは毎週土曜日に定例会を行う。",
                  kind: "rule",
                  scope: { type: "guild" },
                  title: "定例会の曜日",
                  type: "add",
                },
              ],
            }),
          },
        ],
        stopReason: "stop",
      } as never;
    },
  );

  const operations = await processor.process(
    {
      entries: [
        {
          content: "このギルドでは毎週金曜日に定例会を行う。",
          createdAt: "2026-09-11T12:00:00.000Z",
          id: "mem-existing",
          kind: "rule",
          scope: { type: "guild" },
          sourceMessageIds: ["old-message"],
          title: "定例会の曜日",
          updatedAt: "2026-10-05T03:26:33.905Z",
        },
      ],
    },
    [
      {
        channelId: "channel-1",
        content: "さつき:\n土曜日に定例会をしよう。",
        id: "message-1",
      },
    ],
  );

  assert.deepEqual(operations, [
    {
      content: "このギルドでは毎週土曜日に定例会を行う。",
      kind: "rule",
      scope: { type: "guild" },
      title: "定例会の曜日",
      type: "add",
    },
  ]);
  assert.equal(received?.modelId, "deepseek-v4.1-flash");
  assert.equal(received?.reasoning, "low");
  assert.equal(received?.systemPrompt, MEMORY_PROCESSING_SYSTEM_PROMPT);
  assert.match(String(received?.content), /message-1/u);
  assert.match(String(received?.content), /Available scopes:/u);
  assert.match(String(received?.content), /- channel: channel-1/u);
  assert.match(String(received?.content), /Memory ID: mem-existing/u);
  assert.match(String(received?.content), /Scope: guild/u);
  assert.match(String(received?.content), /Updated: 2026-10-05/u);
  assert.doesNotMatch(String(received?.content), /old-message|T03:26:33/u);
});

test("accepts a fenced JSON response and rejects unsupported operations", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
  const fencedProcessor = new PiMemoryProcessor(model, undefined, async () => {
    return {
      role: "assistant",
      content: [{ type: "text", text: '```json\n{"operations":[{"type":"noop"}]}\n```' }],
      stopReason: "stop",
    } as never;
  });
  assert.deepEqual(await fencedProcessor.process({ entries: [] }, []), [{ type: "noop" }]);

  const invalidProcessor = new PiMemoryProcessor(model, undefined, async () => {
    return {
      role: "assistant",
      content: [{ type: "text", text: '{"operations":[{"type":"merge"}]}' }],
      stopReason: "stop",
    } as never;
  });
  await assert.rejects(
    invalidProcessor.process({ entries: [] }, []),
    /unsupported operation: merge/u,
  );
});

test("parses scopes from the batch and rejects unknown channels", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
  const respondWith = (scope: unknown) =>
    new PiMemoryProcessor(model, undefined, async () => {
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              operations: [
                { content: "本文", kind: "fact", scope, title: "タイトル", type: "add" },
              ],
            }),
          },
        ],
        stopReason: "stop",
      } as never;
    });
  const messages = [{ channelId: "channel-1", content: "hello", id: "message-1" }];

  assert.deepEqual(
    await respondWith({ channelId: "channel-1", type: "channel" }).process(
      { entries: [] },
      messages,
    ),
    [
      {
        content: "本文",
        kind: "fact",
        scope: { channelId: "channel-1", type: "channel" },
        title: "タイトル",
        type: "add",
      },
    ],
  );

  await assert.rejects(
    respondWith({ channelId: "unknown", type: "channel" }).process({ entries: [] }, messages),
    /unknown channel: unknown/u,
  );

  const existingScope = { channelId: "channel-9", type: "channel" as const };
  const updateProcessor = new PiMemoryProcessor(model, undefined, async () => {
    return {
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            operations: [
              {
                content: "新本文",
                id: "mem-existing",
                kind: "fact",
                scope: existingScope,
                title: "新タイトル",
                type: "update",
              },
            ],
          }),
        },
      ],
      stopReason: "stop",
    } as never;
  });
  assert.deepEqual(
    await updateProcessor.process(
      {
        entries: [
          {
            content: "旧本文",
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "mem-existing",
            kind: "fact",
            scope: existingScope,
            sourceMessageIds: [],
            title: "旧タイトル",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      messages,
    ),
    [
      {
        content: "新本文",
        id: "mem-existing",
        kind: "fact",
        scope: existingScope,
        title: "新タイトル",
        type: "update",
      },
    ],
  );
});
