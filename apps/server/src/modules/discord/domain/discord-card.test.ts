import assert from "node:assert/strict";
import test from "node:test";

import {
  countCardComponents,
  countCardText,
  displayWidth,
  formatCardBlockText,
  formatCardTable,
  listCardTexts,
  parseDiscordCards,
  type DiscordCard,
} from "./discord-card";

const ALL_BLOCKS: DiscordCard["blocks"] = [
  { kind: "text", text: "All systems normal." },
  { kind: "fields", items: [{ label: "Status", value: "green" }] },
  { kind: "list", items: [{ text: "one", detail: "first" }, { text: "two" }], ordered: true },
  {
    kind: "table",
    columns: ["name", "value"],
    rows: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  { kind: "stats", items: [{ label: "Requests", value: "1.2k", delta: "+5%" }] },
  { kind: "progress", label: "Rollout", value: 0.62, detail: "12 of 20 hosts" },
  { kind: "callout", tone: "warning", text: "Watch latency." },
  { kind: "media", urls: ["https://example.com/a.png"], spoiler: true },
  { kind: "links", items: [{ label: "Logs", url: "https://example.com/logs" }] },
  { kind: "divider" },
];

function parseIssues(input: unknown): readonly string[] {
  const result = parseDiscordCards(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

function parseValid(input: unknown): readonly DiscordCard[] {
  const result = parseDiscordCards(input);
  if (!result.ok) throw new Error(result.issues.join("\n"));
  return result.cards;
}

test("parses every block kind and keeps its fields", () => {
  const cards = parseValid([
    {
      title: "Release",
      accent: "info",
      thumbnail: "https://example.com/t.png",
      blocks: ALL_BLOCKS,
    },
  ]);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.title, "Release");
  assert.equal(cards[0]?.accent, "info");
  assert.equal(cards[0]?.thumbnail, "https://example.com/t.png");
  assert.deepEqual(cards[0]?.blocks, ALL_BLOCKS);
});

test("applies the neutral accent and omits unset optional fields", () => {
  const cards = parseValid([{ blocks: [{ kind: "divider" }] }]);

  assert.deepEqual(cards[0], { accent: "neutral", blocks: [{ kind: "divider" }] });
});

test("drops the ordered and spoiler flags when they are not true", () => {
  const cards = parseValid([
    {
      blocks: [
        { kind: "list", items: [{ text: "one" }] },
        { kind: "media", urls: ["https://example.com/a.png"] },
      ],
    },
  ]);

  assert.deepEqual(cards[0]?.blocks, [
    { kind: "list", items: [{ text: "one" }] },
    { kind: "media", urls: ["https://example.com/a.png"] },
  ]);
});

test("rejects a non-array payload", () => {
  assert.deepEqual(parseIssues({ cards: [] }), [
    "cards: expected an array of card objects. Send at least one card.",
  ]);
});

test("rejects an empty card list", () => {
  assert.deepEqual(parseIssues([]), [
    "cards: expected at least one card. Send one card per message.",
  ]);
});

test("rejects a card without blocks", () => {
  assert.deepEqual(parseIssues([{}]), ["cards[0].blocks: expected an array of blocks."]);
});

test("rejects a card with an empty block list", () => {
  assert.deepEqual(parseIssues([{ blocks: [] }]), [
    "cards[0].blocks: expected at least one block. Add a block or do not send the card.",
  ]);
});

test("rejects an unknown block kind with the block path", () => {
  const issues = parseIssues([{ blocks: [{ kind: "divider" }, { kind: "chart" }] }]);

  assert.deepEqual(issues, [
    'cards[0].blocks[1]: unknown block kind "chart". Use one of: text, fields, list, table, stats, progress, callout, media, links, divider.',
  ]);
});

test("rejects an http thumbnail and says only https is accepted", () => {
  const issues = parseIssues([
    { thumbnail: "http://example.com/t.png", blocks: [{ kind: "divider" }] },
  ]);

  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /^cards\[0\]\.thumbnail: /u);
  assert.match(issues[0] ?? "", /only https URLs are accepted; http: URLs are rejected/u);
});

test("rejects an http link URL with its indexed path", () => {
  const issues = parseIssues([
    {
      blocks: [
        {
          kind: "links",
          items: [{ label: "Docs", url: "http://example.com/docs" }],
        },
      ],
    },
  ]);

  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /^cards\[0\]\.blocks\[0\] \(links\)\.items\[0\]\.url: /u);
  assert.match(issues[0] ?? "", /https/u);
});

test("rejects a message with more than 40 components and reports the total", () => {
  const blocks = Array.from({ length: 40 }, (_, index) => ({
    kind: "text" as const,
    text: `line ${index}`,
  }));
  const issues = parseIssues([{ blocks }]);

  assert.deepEqual(issues, [
    "cards: 41 components exceed Discord's 40-component limit for one message. Drop 1 components or split the cards into two messages.",
  ]);
});

test("rejects a message whose text displays exceed 4000 characters and reports the total", () => {
  const issues = parseIssues([{ blocks: [{ kind: "text", text: "a".repeat(4_001) }] }]);

  assert.deepEqual(issues, [
    "cards: 4001 characters across text displays exceed Discord's 4000-character limit for one message. Shorten the text by 1 characters or split the cards into two messages.",
  ]);
});

test("rejects a table row whose cell count does not match the columns", () => {
  const issues = parseIssues([
    {
      blocks: [
        { kind: "divider" },
        { kind: "table", columns: ["a", "b"], rows: [["1", "2", "3"]] },
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards[0].blocks[1] (table): rows[0] has 3 cells but columns has 2. Pad the row or drop the cell.",
  ]);
});

test("rejects a progress value outside 0..1", () => {
  const issues = parseIssues([{ blocks: [{ kind: "progress", label: "Rollout", value: 1.5 }] }]);

  assert.deepEqual(issues, [
    "cards[0].blocks[0] (progress).value: expected a number between 0 and 1, got 1.5. Use the fraction (0.62), not the percentage.",
  ]);
});

test("rejects more than 10 media URLs", () => {
  const issues = parseIssues([
    {
      blocks: [
        {
          kind: "media",
          urls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}.png`),
        },
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards[0].blocks[0] (media).urls: 11 URLs exceed the 10-item limit of one media gallery. Split them into multiple media blocks.",
  ]);
});

test("rejects more than 5 links", () => {
  const issues = parseIssues([
    {
      blocks: [
        {
          kind: "links",
          items: Array.from({ length: 6 }, (_, index) => ({
            label: `Link ${index}`,
            url: `https://example.com/${index}`,
          })),
        },
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards[0].blocks[0] (links).items: 6 links exceed the 5-button limit of one action row. Split them into two links blocks or drop 1 links.",
  ]);
});

test("counts components and text for a representative card", () => {
  const card: DiscordCard = {
    title: "Release",
    subtitle: "v1.2",
    thumbnail: "https://example.com/t.png",
    footer: "by Klein",
    blocks: ALL_BLOCKS,
  };

  assert.equal(countCardComponents(card), 16);
  assert.ok(countCardText(card) > 0);
});

test("lists every text-bearing field for the promise guard", () => {
  const card: DiscordCard = {
    title: "Title",
    subtitle: "Subtitle",
    footer: "Footer",
    blocks: [
      { kind: "text", text: "text" },
      { kind: "fields", items: [{ label: "label", value: "value" }] },
      { kind: "list", items: [{ text: "item", detail: "detail" }] },
      { kind: "table", columns: ["col"], rows: [["cell"]] },
      { kind: "stats", items: [{ label: "stat", value: "1", delta: "delta" }] },
      { kind: "progress", label: "progress", value: 0.5, detail: "detail" },
      { kind: "callout", tone: "info", text: "callout" },
      { kind: "links", items: [{ label: "link", url: "https://example.com" }] },
      { kind: "divider" },
      { kind: "media", urls: ["https://example.com/a.png"] },
    ],
  };

  assert.deepEqual(listCardTexts(card), [
    "Title",
    "Subtitle",
    "Footer",
    "text",
    "label",
    "value",
    "item",
    "detail",
    "col",
    "cell",
    "stat",
    "1",
    "delta",
    "progress",
    "detail",
    "callout",
    "link",
  ]);
});

test("aligns table columns by display width so CJK rows do not jitter", () => {
  const table = formatCardTable(
    ["名前", "値"],
    [
      ["あ", "1"],
      ["ab", "22"],
    ],
  );

  assert.equal(table, ["```", "名前  値", "あ    1", "ab    22", "```"].join("\n"));
  assert.equal(displayWidth("名前"), 4);
  assert.equal(displayWidth("あ"), 2);
  assert.equal(displayWidth("ab"), 2);
});

test("clamps table cells at 20 display columns", () => {
  const text = formatCardBlockText({
    kind: "table",
    columns: ["name"],
    rows: [["x".repeat(30)]],
  });

  assert.ok(text?.includes(`${"x".repeat(19)}…`));
  assert.ok(!text?.includes("x".repeat(20)));
});

test("caps tables at 6 columns and 20 rows", () => {
  const columns = ["a", "b", "c", "d", "e", "f", "g"];
  const rows = Array.from({ length: 22 }, (_, index) =>
    Array.from({ length: 7 }, (_cellOffset, cell) => `${index}-${cell}`),
  );
  const text = formatCardBlockText({ kind: "table", columns, rows });

  assert.ok(text?.startsWith("```\na "));
  assert.ok(!text?.includes("g"));
  assert.ok(text?.includes("19-0"));
  assert.ok(!text?.includes("20-0"));
  assert.ok(text?.includes("…ほか 2 行"));
});
