import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredModel } from "./pi-agent-runtime";
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
    resolveConfiguredModel("opencode-go", "deepseek-v4-flash"),
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

  const operations = await processor.process({ entries: [] }, [
    {
      channelId: "channel-1",
      content: "さつき:\n土曜日に定例会をしよう。",
      id: "message-1",
    },
  ]);

  assert.deepEqual(operations, [
    {
      content: "このギルドでは毎週土曜日に定例会を行う。",
      kind: "rule",
      title: "定例会の曜日",
      type: "add",
    },
  ]);
  assert.equal(received?.modelId, "deepseek-v4-flash");
  assert.equal(received?.reasoning, "low");
  assert.equal(received?.systemPrompt, MEMORY_PROCESSING_SYSTEM_PROMPT);
  assert.match(String(received?.content), /message-1/u);
});

test("accepts a fenced JSON response and rejects unsupported operations", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4-flash");
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
