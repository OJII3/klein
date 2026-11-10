import assert from "node:assert/strict";
import test from "node:test";

import type { UserMemory } from "@modules/user-memory/domain/user-memory";
import { resolveConfiguredModel } from "./pi-model-runtime";
import {
  PiUserMemoryProcessor,
  USER_MEMORY_PROCESSING_SYSTEM_PROMPT,
} from "./pi-user-memory-processor";

const memory: UserMemory = {
  discordId: "alice",
  displayName: "Alice",
  nickname: "A",
  summary: "TypeScriptが好きなユーザー",
  impression: 10,
  updatedAt: "2026-11-11T00:00:00.000Z",
  facts: "- birthday: 2000-01-02",
  history: "なし",
  inCommon: "- TypeScript",
  strengthening: "なし",
};

test("asks the configured model for a user memory patch", async () => {
  let received:
    | {
        readonly content: unknown;
        readonly modelId: string;
        readonly reasoning?: string;
        readonly systemPrompt?: string;
      }
    | undefined;
  const processor = new PiUserMemoryProcessor(
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
              facts: "- birthday: 2000-01-02\n- favorite: Bun",
              history: "- 2026-11-11: Bunの話をした",
              nickname: "A",
              summary: "Bunが好きなユーザー",
            }),
          },
        ],
        stopReason: "stop",
      } as never;
    },
  );

  const patch = await processor.process(memory, [
    {
      id: "message-1",
      channelId: "channel-1",
      channelName: "雑談",
      occurredAt: "2026-11-11T03:00:00.000Z",
      content: "Alice:\nBunが好き",
    },
  ]);

  assert.deepEqual(patch, {
    facts: "- birthday: 2000-01-02\n- favorite: Bun",
    history: "- 2026-11-11: Bunの話をした",
    nickname: "A",
    summary: "Bunが好きなユーザー",
  });
  assert.equal(received?.modelId, "deepseek-v4.1-flash");
  assert.equal(received?.reasoning, "low");
  assert.equal(received?.systemPrompt, USER_MEMORY_PROCESSING_SYSTEM_PROMPT);
  assert.match(String(received?.content), /discord_id: "alice"/u);
  assert.match(String(received?.content), /message-1/u);
  assert.match(String(received?.content), /channel=雑談 \(channel-1\)/u);
  assert.match(String(received?.content), /at=2026-11-11T03:00:00.000Z/u);
});

test("accepts a fenced JSON response and ignores fields it does not own", async () => {
  const processor = new PiUserMemoryProcessor(
    resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash"),
    undefined,
    async () => {
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '```json\n{"display_name":"Mallory","impression":99,"summary":"Name","facts":""}\n```',
          },
        ],
        stopReason: "stop",
      } as never;
    },
  );

  assert.deepEqual(await processor.process(memory, []), { summary: "Name" });
});

test("rejects malformed and overlong responses", async () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash");
  const respondWith = (text: string) =>
    new PiUserMemoryProcessor(model, undefined, async () => {
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      } as never;
    });

  await assert.rejects(respondWith("not json").process(memory, []), /invalid JSON/u);
  await assert.rejects(respondWith("[]").process(memory, []), /invalid patch/u);
  await assert.rejects(respondWith('{"facts":1}').process(memory, []), /invalid facts/u);
  await assert.rejects(
    respondWith(JSON.stringify({ summary: "a".repeat(501) })).process(memory, []),
    /overlong summary/u,
  );
});
