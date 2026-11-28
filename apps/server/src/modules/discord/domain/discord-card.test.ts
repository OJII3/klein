import assert from "node:assert/strict";
import test from "node:test";

import {
  countCardComponents,
  countCardContainerChildren,
  countCardText,
  displayWidth,
  formatCardBlockText,
  formatCardTable,
  formatCardTexts,
  listCardTextLines,
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

function linkCardWithLabel(length: number) {
  return [
    {
      blocks: [
        {
          kind: "links",
          items: [{ label: "L".repeat(length), url: "https://example.com/docs" }],
        },
      ],
    },
  ];
}

function fiveLinkBlocks(rows: number) {
  return Array.from({ length: rows }, (_, row) => ({
    kind: "links" as const,
    items: Array.from({ length: 5 }, (_cell, index) => ({
      label: `Link ${row}-${index}`,
      url: `https://example.com/${row}/${index}`,
    })),
  }));
}

test("parses every block kind and keeps its fields", () => {
  const cards = parseValid([{ accent: "info", blocks: ALL_BLOCKS }]);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.accent, "info");
  assert.deepEqual(cards[0]?.blocks, ALL_BLOCKS);
});

test("keeps header and footer fields on a card within the container budget", () => {
  const cards = parseValid([
    {
      title: "Release",
      subtitle: "v1.2",
      thumbnail: "https://example.com/t.png",
      footer: "by Klein",
      blocks: [{ kind: "text", text: "hi" }],
    },
  ]);

  assert.equal(cards[0]?.title, "Release");
  assert.equal(cards[0]?.subtitle, "v1.2");
  assert.equal(cards[0]?.thumbnail, "https://example.com/t.png");
  assert.equal(cards[0]?.footer, "by Klein");
});

test("applies the neutral accent and omits unset optional fields", () => {
  const cards = parseValid([{ blocks: [{ kind: "text", text: "hi" }] }]);

  assert.deepEqual(cards[0], { accent: "neutral", blocks: [{ kind: "text", text: "hi" }] });
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

test("rejects a card that only has dividers", () => {
  assert.deepEqual(parseIssues([{ blocks: [{ kind: "divider" }] }]), [
    "cards[0]: has no content. Add a title, text, media, links, or a content block.",
  ]);
});

test("keeps a divider card when it has a title", () => {
  const cards = parseValid([{ title: "Section", blocks: [{ kind: "divider" }] }]);

  assert.deepEqual(cards[0]?.blocks, [{ kind: "divider" }]);
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

test("trims surrounding whitespace before storing a URL", () => {
  const cards = parseValid([
    {
      blocks: [
        {
          kind: "links",
          items: [{ label: "Docs", url: " https://example.com/docs\n" }],
        },
      ],
    },
  ]);

  const block = cards[0]?.blocks[0];
  assert.equal(
    block?.kind === "links" ? block.items[0]?.url : undefined,
    "https://example.com/docs",
  );
});

test("normalizes URLs to the form the renderer emits", () => {
  const input = "HTTPS://例え.jp/画像.png";
  const cards = parseValid([
    { blocks: [{ kind: "links", items: [{ label: "Docs", url: input }] }] },
  ]);

  const block = cards[0]?.blocks[0];
  assert.equal(block?.kind === "links" ? block.items[0]?.url : undefined, new URL(input).href);
});

test("rejects URLs with whitespace, control characters, or no host", () => {
  const urls = [
    "https://example.com/a b",
    "https://example.com/\u0000logs",
    "https://example.com/\u0085logs",
    "https://example.com/\u200blogs",
    "https://example.com/\u202elogs",
    "https:///logs",
    "https:example.com/logs",
  ];
  for (const url of urls) {
    const issues = parseIssues([{ blocks: [{ kind: "links", items: [{ label: "Docs", url }] }] }]);
    assert.match(issues[0] ?? "", /^cards\[0\]\.blocks\[0\] \(links\)\.items\[0\]\.url: /u);
    assert.match(issues[0] ?? "", /plain https:\/\/host\/path URL/u);
  }
});

test("accepts an 80-character link label and rejects 81", () => {
  assert.equal(parseValid(linkCardWithLabel(80)).length, 1);
  const issues = parseIssues(linkCardWithLabel(81));
  assert.match(issues[0] ?? "", /^cards\[0\]\.blocks\[0\] \(links\)\.items\[0\]\.label: /u);
  assert.match(issues[0] ?? "", /limit is 80/u);
});

test("caps link URLs at 512 characters and media URLs at 2048", () => {
  const linkBase = "https://example.com/";
  const mediaBase = "https://example.com/";
  const link = (length: number) => linkBase + "a".repeat(length - linkBase.length);
  const media = (length: number) => mediaBase + "a".repeat(length - mediaBase.length);

  assert.equal(
    parseValid([{ blocks: [{ kind: "links", items: [{ label: "Docs", url: link(512) }] }] }])
      .length,
    1,
  );
  assert.match(
    parseIssues([{ blocks: [{ kind: "links", items: [{ label: "Docs", url: link(513) }] }] }])[0] ??
      "",
    /limit is 512/u,
  );
  assert.equal(parseValid([{ blocks: [{ kind: "media", urls: [media(2_048)] }] }]).length, 1);
  assert.match(
    parseIssues([{ blocks: [{ kind: "media", urls: [media(2_049)] }] }])[0] ?? "",
    /limit is 2048/u,
  );
});

test("rejects non-string table cells with their cell path", () => {
  const issues = parseIssues([
    {
      blocks: [
        { kind: "divider" },
        { kind: "divider" },
        { kind: "table", columns: ["a", "b"], rows: [["ok", null]] },
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards[0].blocks[2].rows[0][1]: table cells must be strings, got null.",
  ]);
});

test("returns a result instead of throwing for odd structures", () => {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let index = 0; index < 200; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }

  const inputs: readonly unknown[] = [
    [[{ blocks: [{ kind: "text", text: "a" }] }]],
    [{ blocks: [deep] }],
    [{ blocks: [{ kind: deep }] }],
    [{ blocks: [{ kind: "table", columns: ["a"], rows: [[deep]] }] }],
    [Object.assign(Object.create(null), { blocks: "text" })],
    Array.from({ length: 10_000 }, () => null),
  ];

  for (const input of inputs) {
    const result = parseDiscordCards(input);
    assert.equal(typeof result.ok, "boolean");
  }
});

test("rejects blank text blocks and header fields", () => {
  for (const text of ["", "   ", "\n", "\u200b", "\u200b\u200b"]) {
    assert.match(
      parseIssues([{ blocks: [{ kind: "text", text }] }])[0] ?? "",
      /^cards\[0\]\.blocks\[0\] \(text\)\.text: /u,
    );
  }
  assert.deepEqual(parseIssues([{ blocks: [{ kind: "text", text: " " }] }]), [
    "cards[0].blocks[0] (text).text: expected the text body as a non-empty string.",
  ]);
  for (const field of ["title", "subtitle", "footer"] as const) {
    assert.match(
      parseIssues([{ [field]: "\u200b", blocks: [{ kind: "text", text: "hi" }] }])[0] ?? "",
      new RegExp(`^cards\\[0\\]\\.${field}: `, "u"),
    );
  }
});

test("rejects a card whose container would exceed 10 children", () => {
  const blocks = Array.from({ length: 11 }, (_, index) => ({
    kind: "text" as const,
    text: `line ${index}`,
  }));
  assert.deepEqual(parseIssues([{ blocks }]), [
    "cards[0]: 11 container children exceed Discord's 10-per-container limit. Split the card into two cards.",
  ]);
  assert.equal(parseValid([{ blocks: blocks.slice(0, 10) }]).length, 1);
});

test("counts the header and footer as container children", () => {
  const blocks = Array.from({ length: 9 }, (_, index) => ({
    kind: "text" as const,
    text: `line ${index}`,
  }));
  assert.deepEqual(parseIssues([{ title: "Title", footer: "Footer", blocks }]), [
    "cards[0]: 11 container children exceed Discord's 10-per-container limit. Split the card into two cards.",
  ]);
  assert.equal(
    countCardContainerChildren({ title: "Title", footer: "Footer", blocks: blocks.slice(0, 8) }),
    10,
  );
});

test("rejects more than 5 action rows across the message", () => {
  const linksBlock = {
    kind: "links" as const,
    items: [{ label: "Docs", url: "https://example.com/docs" }],
  };
  const blocks = Array.from({ length: 6 }, () => linksBlock);
  assert.deepEqual(parseIssues([{ blocks }]), [
    "cards: 6 action rows exceed Discord's 5-per-message limit. Split the links across two messages.",
  ]);
  assert.equal(parseValid([{ blocks: blocks.slice(0, 5) }]).length, 1);
});

test("rejects a message with more than 40 components and reports the total", () => {
  const issues = parseIssues([
    {
      title: "Release",
      thumbnail: "https://example.com/t.png",
      footer: "by Klein",
      blocks: fiveLinkBlocks(2),
    },
    {
      blocks: [
        ...fiveLinkBlocks(3),
        ...Array.from({ length: 5 }, (_, index) => ({
          kind: "text" as const,
          text: `line ${index}`,
        })),
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards: 41 components exceed Discord's 40-component limit for one message. Drop 1 component or split the cards into two messages.",
  ]);
});

test("rejects a message whose text displays exceed 4000 characters and reports the total", () => {
  const issues = parseIssues([{ blocks: [{ kind: "text", text: "a".repeat(4_001) }] }]);

  assert.deepEqual(issues, [
    "cards: 4001 characters across text displays exceed Discord's 4000-character limit for one message. Shorten the text by 1 character or split the cards into two messages.",
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
    "cards[0].blocks[0] (links).items: 6 links exceed the 5-button limit of one action row. Split them into two links blocks or drop one link.",
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

test("formats the exact text displays the renderer emits", () => {
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

  const texts = formatCardTexts(card);
  assert.equal(texts.header, "### Title\n-# Subtitle");
  assert.equal(texts.blocks[1], "**label**\u2002value");
  assert.equal(texts.blocks[4], "**1** stat\n-# delta");
  assert.equal(texts.blocks[7], undefined);
  assert.equal(texts.footer, "-# Footer");

  const lines = listCardTextLines(card);
  assert.ok(lines.includes("### Title"));
  assert.ok(lines.includes("-# Subtitle"));
  assert.ok(lines.includes("text"));
  assert.ok(lines.includes("**label**\u2002value"));
  assert.ok(lines.includes("**1** stat"));
  assert.ok(lines.includes("cell"));
  assert.ok(lines.includes("-# Footer"));
});

test("joins split fields, stats, and table cells onto one emitted line", () => {
  const card: DiscordCard = {
    blocks: [
      { kind: "fields", items: [{ label: "後で", value: "報告します" }] },
      { kind: "stats", items: [{ value: "後で", label: "報告します" }] },
      { kind: "table", columns: ["いつ", "なに"], rows: [["後で", "報告します"]] },
    ],
  };

  const lines = listCardTextLines(card);
  assert.ok(lines.includes("**後で**\u2002報告します"));
  assert.ok(lines.includes("**後で** 報告します"));
  assert.ok(lines.some((line) => line.startsWith("後で") && line.includes("報告します")));
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

test("rejects tables with more than 6 columns", () => {
  const columns = ["a", "b", "c", "d", "e", "f", "g"];
  const issues = parseIssues([
    {
      blocks: [
        {
          kind: "table",
          columns,
          rows: [columns.map((_, index) => `${index}`)],
        },
      ],
    },
  ]);

  assert.deepEqual(issues, [
    "cards[0].blocks[0] (table): 7 columns exceed the 6-column limit. Split it into two tables or drop a column.",
  ]);
});

test("rejects tables with more than 20 rows", () => {
  const rows = Array.from({ length: 21 }, (_, index) => [`row-${index}`]);
  const issues = parseIssues([{ blocks: [{ kind: "table", columns: ["name"], rows }] }]);

  assert.deepEqual(issues, [
    "cards[0].blocks[0] (table): 21 rows exceed the 20-row limit. Split it into two tables or drop a row.",
  ]);
});

test("accepts a table at the 6-column and 20-row limits", () => {
  const columns = ["a", "b", "c", "d", "e", "f"];
  const rows = Array.from({ length: 20 }, (_, index) =>
    columns.map((_column, cell) => `${index}-${cell}`),
  );

  const cards = parseValid([{ blocks: [{ kind: "table", columns, rows }] }]);
  assert.equal(cards.length, 1);
});
