import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type {
  DiscordChannelHistoryMessage,
  DiscordChannelHistoryPageRequest,
} from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { isRecord } from "@shared/type-guards";
import {
  createDiscordChannelHistoryContentTool,
  createDiscordChannelHistoryTool,
  DiscordChannelHistoryStore,
} from "./discord-channel-history";

const user = {
  bot: false,
  id: "123456789012345678",
  username: "satsuki",
  displayName: "さつき",
};

function historyMessage(
  overrides: Partial<DiscordChannelHistoryMessage> = {},
): DiscordChannelHistoryMessage {
  return {
    attachments: [],
    author: user,
    channelId: "current-channel",
    content: "本文です",
    id: "message-456",
    occurredAt: "2026-10-14T09:30:42.123Z",
    ...overrides,
  };
}

type ReadMessages = Pick<DiscordChannelApi, "readMessages">["readMessages"];

function createHistoryTool(readMessages: ReadMessages, currentChannelId = "current-channel") {
  const store = new DiscordChannelHistoryStore();
  return {
    contentTool: createDiscordChannelHistoryContentTool(store),
    store,
    tool: createDiscordChannelHistoryTool({ readMessages }, currentChannelId, store),
  };
}

async function execute<
  TParams,
  TResult extends { content: readonly { type: string; text?: string }[] },
>(
  tool: {
    execute(
      toolCallId: string,
      params: TParams,
      signal: undefined,
      onUpdate: undefined,
      context: ExtensionToolContext,
    ): Promise<TResult>;
  },
  params: TParams,
): Promise<TResult> {
  return tool.execute(
    "tool-call",
    params,
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map((content) => (content.type === "text" ? (content.text ?? "") : ""))
    .join("");
}

function requireString(details: unknown, key: string): string {
  assert.ok(isRecord(details));
  const value = details[key];
  assert.ok(typeof value === "string");
  return value;
}

test("requires channelId in its schema and names the current channel", () => {
  const { tool } = createHistoryTool(async () => []);
  const parameters: unknown = tool.parameters;

  assert.ok(isRecord(parameters));
  assert.ok(Array.isArray(parameters.required));
  assert.ok(parameters.required.includes("channelId"));
  assert.ok(isRecord(parameters.properties));
  assert.ok(isRecord(parameters.properties.channelId));
  assert.equal(parameters.properties.channelId.type, "string");
  assert.match(String(parameters.properties.channelId.description), /current-channel/);
});

test("rejects an empty channelId with the current channel hint", async () => {
  const { tool } = createHistoryTool(async () => []);

  await assert.rejects(
    execute(tool, { channelId: "" }),
    /channelId は必須です。この会話の現在のチャンネルは current-channel です。/,
  );
});

test("reads the specified channel with the default limit and newest-first order", async () => {
  const requests: DiscordChannelHistoryPageRequest[] = [];
  const { tool } = createHistoryTool(async (request) => {
    requests.push(request);
    return [
      historyMessage({ id: "message-new", content: "新しい本文" }),
      historyMessage({ id: "message-old", content: "古い本文" }),
    ];
  });

  const result = await execute(tool, { channelId: "current-channel" });

  assert.deepEqual(requests, [{ channelId: "current-channel", limit: 30 }]);
  const text = textOf(result);
  assert.match(text, /channelId=current-channel, order=newest, count=2/);
  assert.ok(text.indexOf("message-new") < text.indexOf("message-old"));
  const details: unknown = result.details;
  assert.ok(isRecord(details));
  assert.deepEqual(details.messageIds, ["message-new", "message-old"]);
});

test("reads an explicitly provided channel and forwards before or after", async () => {
  const requests: DiscordChannelHistoryPageRequest[] = [];
  const { tool } = createHistoryTool(async (request) => {
    requests.push(request);
    return [];
  });

  await execute(tool, { before: "message-older", channelId: "linked-channel", limit: 5 });
  await execute(tool, { after: "message-newer", channelId: "linked-channel", limit: 5 });

  assert.deepEqual(requests, [
    { before: "message-older", channelId: "linked-channel", limit: 5 },
    { after: "message-newer", channelId: "linked-channel", limit: 5 },
  ]);
});

test("rejects before and after together", async () => {
  let reads = 0;
  const { tool } = createHistoryTool(async () => {
    reads += 1;
    return [];
  });

  await assert.rejects(
    execute(tool, {
      after: "message-newer",
      before: "message-older",
      channelId: "current-channel",
    }),
    /before と after は同時に指定できません/,
  );
  assert.equal(reads, 0);
});

test("clamps the limit to the 1-100 range and defaults to 30", async () => {
  const limits: number[] = [];
  const { tool } = createHistoryTool(async (request) => {
    limits.push(request.limit);
    return [];
  });

  await execute(tool, { channelId: "current-channel", limit: 500 });
  await execute(tool, { channelId: "current-channel", limit: 0 });
  await execute(tool, { channelId: "current-channel" });

  assert.deepEqual(limits, [100, 1, 30]);
});

test("returns oldest first when order is oldest", async () => {
  const { tool } = createHistoryTool(async () => [
    historyMessage({ id: "message-new", content: "新しい本文" }),
    historyMessage({ id: "message-old", content: "古い本文" }),
  ]);

  const result = await execute(tool, { channelId: "current-channel", order: "oldest" });

  const text = textOf(result);
  assert.match(text, /order=oldest/);
  assert.ok(text.indexOf("message-old") < text.indexOf("message-new"));
});

test("includes messages authored by bots", async () => {
  const { tool } = createHistoryTool(async () => [
    historyMessage({
      author: { bot: true, id: "bot-123", username: "klein", displayName: "クライン" },
      content: "Botの本文",
    }),
  ]);

  const result = await execute(tool, { channelId: "current-channel" });

  assert.match(textOf(result), /クライン \(@klein\) \| userId=bot-123\nBotの本文/);
});

test("formats attachments with their filenames and URLs", async () => {
  const { tool } = createHistoryTool(async () => [
    historyMessage({
      attachments: [
        {
          filename: "sample.png",
          url: "https://cdn.discordapp.com/attachments/sample.png",
        },
      ],
    }),
  ]);

  const result = await execute(tool, { channelId: "current-channel" });

  assert.match(
    textOf(result),
    /\[添付: sample\.png \(https:\/\/cdn\.discordapp\.com\/attachments\/sample\.png\)\]/,
  );
});

test("truncates long bodies in the tool output and keeps the full text in stored content", async () => {
  const content = "あ".repeat(2_000);
  const { contentTool, tool } = createHistoryTool(async () => [historyMessage({ content })]);

  const result = await execute(tool, { channelId: "current-channel" });
  const text = textOf(result);
  const responseId = requireString(result.details, "responseId");

  assert.match(text, /… \(truncated, 2000 chars total\)/);
  assert.equal((text.match(/あ/gu) ?? []).length, 1_500);

  const stored = await execute(contentTool, { responseId });

  assert.equal((textOf(stored).match(/あ/gu) ?? []).length, 2_000);
  assert.doesNotMatch(textOf(stored), /truncated/);
});

test("stores history under a responseId and pages through it", async () => {
  const { contentTool, tool } = createHistoryTool(async () => [
    historyMessage({ id: "message-1", content: "1件目" }),
    historyMessage({ id: "message-2", content: "2件目" }),
    historyMessage({ id: "message-3", content: "3件目" }),
  ]);

  const result = await execute(tool, { channelId: "current-channel" });
  const responseId = requireString(result.details, "responseId");
  assert.match(textOf(result), new RegExp(`responseId "${responseId}"`));

  const page = await execute(contentTool, { limit: 1, offset: 1, responseId });

  const pageText = textOf(page);
  assert.match(pageText, /2-2 of 3/);
  assert.doesNotMatch(pageText, /1件目/);
  assert.match(pageText, /2件目/);
  assert.doesNotMatch(pageText, /3件目/);
  assert.match(pageText, /offset: 2/);
  assert.deepEqual(page.details, {
    channelId: "current-channel",
    found: true,
    limit: 1,
    offset: 1,
    order: "newest",
    responseId,
    returned: 1,
    total: 3,
  });
});

test("reports an unknown responseId without throwing", async () => {
  const { contentTool } = createHistoryTool(async () => []);

  const result = await execute(contentTool, { responseId: "missing" });

  assert.match(textOf(result), /responseId "missing" の保存内容が見つかりません/);
  assert.deepEqual(result.details, { found: false, responseId: "missing" });
});

test("reports an out-of-range offset", async () => {
  const { contentTool, tool } = createHistoryTool(async () => [
    historyMessage({ id: "message-1" }),
  ]);

  const result = await execute(tool, { channelId: "current-channel" });
  const responseId = requireString(result.details, "responseId");
  const page = await execute(contentTool, { offset: 5, responseId });

  assert.match(textOf(page), /offset 5 は範囲外です。.*0-0 の範囲で指定してください/);
});

test("returns a note when the channel has no messages", async () => {
  const { tool } = createHistoryTool(async () => []);

  const result = await execute(tool, { channelId: "current-channel" });

  assert.match(textOf(result), /count=0/);
  assert.match(textOf(result), /メッセージはありませんでした。/);
});

for (const [name, error, expected] of [
  [
    "Missing Permissions",
    Object.assign(new Error("Missing Permissions"), { code: 50013 }),
    /閲覧権限がありません \(Missing Permissions\)/,
  ],
  [
    "Missing Access",
    Object.assign(new Error("Missing Access"), { code: 50001 }),
    /アクセスできません \(Missing Access\)/,
  ],
  [
    "rate limit",
    Object.assign(new Error("rate limit exceeded"), { status: 429 }),
    /レート制限に達しました \(429\)/,
  ],
  [
    "Unknown Channel",
    Object.assign(new Error("Unknown Channel"), { code: 10003 }),
    /チャンネルが見つかりません \(Unknown Channel\)/,
  ],
  [
    "Unknown Message",
    Object.assign(new Error("Unknown Message"), { code: 10008 }),
    /メッセージが見つかりません \(Unknown Message\)/,
  ],
  [
    "access denied",
    new Error("Discord channel access denied: channel-1"),
    /履歴を読む権限がありません/,
  ],
  [
    "not text based",
    new Error("Discord channel cannot contain messages: channel-1"),
    /テキストチャンネルではありません/,
  ],
  ["unknown failure", new Error("boom"), /channel-1\): boom/],
] as const) {
  test(`translates a ${name} failure into a readable error`, async () => {
    const { tool } = createHistoryTool(async () => {
      throw error;
    });

    await assert.rejects(execute(tool, { channelId: "channel-1" }), expected);
  });
}
