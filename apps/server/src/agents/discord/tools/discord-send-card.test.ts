import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { DiscordCard } from "@modules/discord/domain/discord-card";
import type { PromiseGuard } from "../../tools/promise-guard";
import { createDiscordSendCardTool } from "./discord-send-card";

const CARD_INPUT = {
  cards: [
    {
      title: "Deploys",
      accent: "info",
      blocks: [
        { kind: "fields", items: [{ label: "Status", value: "green" }] },
        { kind: "links", items: [{ label: "Logs", url: "https://example.com/logs" }] },
      ],
    },
  ],
};

test("sends parsed cards, types first, and returns the message ids", async () => {
  let typingCount = 0;
  let sentCards: readonly DiscordCard[] | undefined;
  let hookCalled = false;
  const tool = createDiscordSendCardTool(
    {
      async sendTyping() {
        typingCount += 1;
      },
      async sendCard(_channelId, cards) {
        sentCards = cards;
        return ["message-301"];
      },
    },
    "current-channel",
    undefined,
    () => {
      hookCalled = true;
    },
  );

  const result = await tool.execute(
    "tool-call",
    CARD_INPUT,
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(typingCount, 1);
  assert.deepEqual(sentCards, [
    {
      title: "Deploys",
      accent: "info",
      blocks: [
        { kind: "fields", items: [{ label: "Status", value: "green" }] },
        { kind: "links", items: [{ label: "Logs", url: "https://example.com/logs" }] },
      ],
    },
  ]);
  assert.deepEqual(result.content, [
    { type: "text", text: 'Sent a card: "Deploys" with 2 blocks to Discord.' },
  ]);
  assert.deepEqual(result.details, { messageIds: ["message-301"] });
  assert.equal(hookCalled, true);
});

test("blocks a card whose text promises an untracked follow-up", async () => {
  const checked: string[] = [];
  let sent = false;
  let typingCount = 0;
  const guard: PromiseGuard = {
    async check(content) {
      checked.push(content);
      return content === "後で報告します"
        ? { action: "block", reason: "no-active-follow-up" }
        : { action: "allow" };
    },
  };
  const tool = createDiscordSendCardTool(
    {
      async sendTyping() {
        typingCount += 1;
      },
      async sendCard() {
        sent = true;
        return [];
      },
    },
    "current-channel",
    guard,
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      {
        cards: [
          {
            title: "進捗",
            blocks: [{ kind: "text", text: "後で報告します" }],
            footer: "以上",
          },
        ],
      },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /promises a later report.*follow_up_create/u,
  );
  assert.deepEqual(checked, ["### 進捗", "後で報告します"]);
  assert.equal(typingCount, 0);
  assert.equal(sent, false);
});

test("checks the emitted line for fields, stats, and table rows", async () => {
  const checked: string[] = [];
  const guard: PromiseGuard = {
    async check(content) {
      checked.push(content);
      return { action: "allow" };
    },
  };
  const tool = createDiscordSendCardTool(
    {
      async sendTyping() {},
      async sendCard() {
        return ["message-302"];
      },
    },
    "current-channel",
    guard,
  );
  const cards = [
    {
      title: "進捗",
      blocks: [{ kind: "fields", items: [{ label: "後で", value: "報告します" }] }],
    },
    {
      title: "進捗",
      blocks: [{ kind: "stats", items: [{ label: "報告します", value: "後で" }] }],
    },
    {
      title: "進捗",
      blocks: [{ kind: "table", columns: ["いつ", "なに"], rows: [["後で", "報告します"]] }],
    },
  ];

  for (const card of cards) {
    checked.length = 0;
    await tool.execute(
      "tool-call",
      { cards: [card] },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    );
    assert.ok(
      checked.some((line) => /後で.{0,10}報告します/u.test(line)),
      `guard saw ${JSON.stringify(checked)}`,
    );
  }
});

test("rejects a link label longer than 80 characters before rendering", async () => {
  let typingCount = 0;
  let sent = false;
  const tool = createDiscordSendCardTool(
    {
      async sendTyping() {
        typingCount += 1;
      },
      async sendCard() {
        sent = true;
        return [];
      },
    },
    "current-channel",
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      {
        cards: [
          {
            blocks: [
              {
                kind: "links",
                items: [{ label: "L".repeat(81), url: "https://example.com/logs" }],
              },
            ],
          },
        ],
      },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /items\[0\]\.label: link label is 81 characters; the limit is 80/u,
  );
  assert.equal(typingCount, 0);
  assert.equal(sent, false);
});

test("refuses an invalid card and sends nothing", async () => {
  let sent = false;
  let typingCount = 0;
  const tool = createDiscordSendCardTool(
    {
      async sendTyping() {
        typingCount += 1;
      },
      async sendCard() {
        sent = true;
        return [];
      },
    },
    "current-channel",
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      {
        cards: [
          {
            thumbnail: "http://example.com/thumb.png",
            blocks: [{ kind: "divider" }],
          },
        ],
      },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /cards\[0\]\.thumbnail: only https URLs are accepted; http: URLs are rejected/u,
  );
  assert.equal(typingCount, 0);
  assert.equal(sent, false);
});
