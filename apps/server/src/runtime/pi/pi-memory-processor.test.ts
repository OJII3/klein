import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredModel } from "./pi-model-runtime";
import { MEMORY_PROCESSING_SYSTEM_PROMPT, PiMemoryProcessor } from "./pi-memory-processor";
import { createStubAssistantMessage } from "./pi-test-helpers";

test("asks the configured model for complete facts and preferences per scope", async () => {
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
      return createStubAssistantMessage({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              updates: [
                {
                  facts: ["定例会は毎週土曜日に開催する。"],
                  preferences: ["返信は簡潔にする。"],
                  scope: { type: "guild" },
                },
              ],
            }),
          },
        ],
      });
    },
  );

  const updates = await processor.process(
    [
      {
        memory: {
          facts: ["定例会は毎週金曜日に開催する。"],
          preferences: [],
        },
        scope: { type: "guild" },
      },
      {
        memory: { facts: [], preferences: [] },
        scope: { channelId: "channel-1", type: "channel" },
      },
    ],
    [
      {
        channelId: "channel-1",
        content: "さつき:\n土曜日に定例会をしよう。",
        id: "message-1",
      },
    ],
  );

  assert.deepEqual(updates, [
    {
      memory: {
        facts: ["定例会は毎週土曜日に開催する。"],
        preferences: ["返信は簡潔にする。"],
      },
      scope: { type: "guild" },
    },
  ]);
  assert.equal(received?.modelId, "deepseek-v4.1-flash");
  assert.equal(received?.reasoning, "low");
  assert.equal(received?.systemPrompt, MEMORY_PROCESSING_SYSTEM_PROMPT);
  assert.match(String(received?.content), /channel=channel-1/u);
  assert.match(String(received?.content), /Available scopes:/u);
  assert.match(String(received?.content), /- channel: channel-1/u);
  assert.match(String(received?.content), /定例会は毎週金曜日に開催する。/u);
  assert.match(String(received?.content), /## Guild/u);
  assert.doesNotMatch(String(received?.content), /Memory ID:|Kind:|Updated:/u);
});

test("accepts a fenced JSON response and rejects malformed updates", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
  const fencedProcessor = new PiMemoryProcessor(model, undefined, async () => {
    return createStubAssistantMessage({
      content: [
        {
          type: "text",
          text: '```json\n{"updates":[{"scope":{"type":"guild"},"facts":["- 事実"],"preferences":[" 好み "]}]}\n```',
        },
      ],
    });
  });
  assert.deepEqual(
    await fencedProcessor.process([{ memory: emptyMemory(), scope: { type: "guild" } }], []),
    [
      {
        memory: { facts: ["事実"], preferences: ["好み"] },
        scope: { type: "guild" },
      },
    ],
  );

  const invalidProcessor = new PiMemoryProcessor(model, undefined, async () => {
    return createStubAssistantMessage({
      content: [
        { type: "text", text: '{"updates":[{"scope":{"type":"guild"},"facts":"not-array"}]}' },
      ],
    });
  });
  await assert.rejects(
    invalidProcessor.process([{ memory: emptyMemory(), scope: { type: "guild" } }], []),
    /invalid update.facts/u,
  );
});

test("rejects unknown and duplicate scopes", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
  const respondWith = (updates: unknown) =>
    new PiMemoryProcessor(model, undefined, async () => {
      return createStubAssistantMessage({
        content: [{ type: "text", text: JSON.stringify({ updates }) }],
      });
    });
  const scopes = [{ memory: emptyMemory(), scope: { type: "guild" as const } }];

  await assert.rejects(
    respondWith([
      {
        facts: [],
        preferences: [],
        scope: { channelId: "channel-1", type: "channel" },
      },
    ]).process(scopes, []),
    /unknown scope: channel:channel-1/u,
  );

  await assert.rejects(
    respondWith([
      { facts: [], preferences: [], scope: { type: "guild" } },
      { facts: [], preferences: [], scope: { type: "guild" } },
    ]).process(scopes, []),
    /duplicate scope: guild/u,
  );
});

function emptyMemory() {
  return { facts: [], preferences: [] };
}
