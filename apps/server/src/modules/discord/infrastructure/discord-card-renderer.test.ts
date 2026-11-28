import assert from "node:assert/strict";
import test from "node:test";

import { MessageFlags } from "discord.js";

import {
  countCardComponents,
  countCardContainerChildren,
  countCardText,
  formatCardTable,
  parseDiscordCards,
  type DiscordCard,
  type DiscordCardBlock,
} from "../domain/discord-card";
import { renderDiscordCards } from "./discord-card-renderer";

const BLOCK_VARIANTS: readonly DiscordCardBlock[] = [
  { kind: "text", text: "All systems normal." },
  { kind: "fields", items: [{ label: "Status", value: "green" }] },
  { kind: "list", items: [{ text: "one", detail: "first" }, { text: "two" }], ordered: true },
  {
    kind: "table",
    columns: ["name", "value"],
    rows: Array.from({ length: 20 }, (_, index) => [`row-${index}`, `${index}`]),
  },
  { kind: "stats", items: [{ label: "Requests", value: "1.2k", delta: "+5%" }] },
  { kind: "progress", label: "Rollout", value: 0.62, detail: "12 of 20 hosts" },
  { kind: "callout", tone: "warning", text: "Watch latency." },
  {
    kind: "media",
    urls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}.png`),
    spoiler: true,
  },
  {
    kind: "links",
    items: Array.from({ length: 5 }, (_, index) => ({
      label: `Link ${index}`,
      url: `https://example.com/${index}`,
    })),
  },
  { kind: "divider" },
];

function countRenderedComponents(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, entry) => total + countRenderedComponents(entry), 0);
  }
  if (!isRecord(value)) return 0;
  let total = typeof value.type === "number" ? 1 : 0;
  for (const child of [value.components, value.accessory, value.items]) {
    total += countRenderedComponents(child);
  }
  return total;
}

function renderedTextCharacters(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, entry) => total + renderedTextCharacters(entry), 0);
  }
  if (!isRecord(value)) return 0;
  const own = value.type === 10 && typeof value.content === "string" ? value.content.length : 0;
  return (
    own +
    renderedTextCharacters(value.components) +
    renderedTextCharacters(value.accessory) +
    renderedTextCharacters(value.items)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("renders a card as one components v2 container", () => {
  const card: DiscordCard = {
    title: "Release",
    subtitle: "v1.2",
    accent: "success",
    thumbnail: "https://example.com/thumb.png",
    footer: "by Klein",
    blocks: [
      { kind: "divider" },
      {
        kind: "media",
        urls: ["https://example.com/a.png", "https://example.com/b.png"],
        spoiler: true,
      },
      {
        kind: "links",
        items: [
          { label: "Docs", url: "https://example.com/docs" },
          { label: "Logs", url: "https://example.com/logs" },
        ],
      },
    ],
  };

  const rendered = renderDiscordCards([card]);

  assert.equal(rendered.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(
    rendered.components.map((component) => component.toJSON()),
    [
      {
        type: 17,
        accent_color: 0x57f287,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: "### Release\n-# v1.2" }],
            accessory: { type: 11, media: { url: "https://example.com/thumb.png" } },
          },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 12,
            items: [
              { media: { url: "https://example.com/a.png" }, spoiler: true },
              { media: { url: "https://example.com/b.png" }, spoiler: true },
            ],
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Docs",
                url: "https://example.com/docs",
                emoji: undefined,
              },
              {
                type: 2,
                style: 5,
                label: "Logs",
                url: "https://example.com/logs",
                emoji: undefined,
              },
            ],
          },
          { type: 10, content: "-# by Klein" },
        ],
      },
    ],
  );
});

test("maps every accent to its color", () => {
  const accents = ["neutral", "info", "success", "warning", "danger"] as const;
  const colors = accents.map((accent) => {
    const card: DiscordCard = { accent, blocks: [{ kind: "divider" }] };
    return renderDiscordCards([card]).components[0]?.toJSON().accent_color;
  });

  assert.deepEqual(colors, [0x747f8d, 0x5865f2, 0x57f287, 0xfee75c, 0xed4245]);
});

test("renders header-less cards without a section", () => {
  const rendered = renderDiscordCards([{ blocks: [{ kind: "text", text: "hi" }] }]);

  assert.deepEqual(rendered.components[0]?.toJSON(), {
    type: 17,
    accent_color: 0x747f8d,
    components: [{ type: 10, content: "hi" }],
  });
});

test("renders the CJK table with display-width alignment", () => {
  const rendered = renderDiscordCards([
    {
      blocks: [
        {
          kind: "table",
          columns: ["名前", "値"],
          rows: [
            ["あ", "1"],
            ["ab", "22"],
          ],
        },
      ],
    },
  ]);

  const table = rendered.components[0]?.toJSON().components?.[0];
  assert.deepEqual(table, {
    type: 10,
    content: formatCardTable(
      ["名前", "値"],
      [
        ["あ", "1"],
        ["ab", "22"],
      ],
    ),
  });
  assert.equal(table?.content, ["```", "名前  値", "あ    1", "ab    22", "```"].join("\n"));
});

test("valid cards never exceed 40 components or 4000 text characters", () => {
  const cards: readonly DiscordCard[] = [
    { blocks: BLOCK_VARIANTS },
    {
      title: "Release",
      subtitle: "v1.2",
      thumbnail: "https://example.com/thumb.png",
      footer: "by Klein",
      blocks: BLOCK_VARIANTS.slice(0, 6),
    },
    { title: "Title only", subtitle: "no thumbnail", blocks: [{ kind: "text", text: "a" }] },
    {
      blocks: [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ],
    },
  ];

  for (const card of cards) {
    const parsed = parseDiscordCards([card]);
    if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
    const rendered = renderDiscordCards([card]);
    const json = rendered.components.map((component) => component.toJSON());

    const components = countRenderedComponents(json);
    assert.ok(components <= 40, `rendered ${components} components`);
    assert.equal(components, countCardComponents(card));
    assert.ok(countCardContainerChildren(card) <= 10);

    const characters = renderedTextCharacters(json);
    assert.ok(characters <= 4_000, `rendered ${characters} text characters`);
    assert.equal(characters, countCardText(card));
  }
});

test("renders every accepted block shape into a valid payload", () => {
  for (const block of BLOCK_VARIANTS) {
    const parsed = parseDiscordCards([
      block.kind === "divider" ? { title: "Section", blocks: [block] } : { blocks: [block] },
    ]);
    if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
    const rendered = renderDiscordCards(parsed.cards);
    const json = rendered.components.map((component) => component.toJSON());
    assert.equal(countRenderedComponents(json), countCardComponents(parsed.cards[0]));
    assert.equal(renderedTextCharacters(json), countCardText(parsed.cards[0]));
  }
});

test("renders the maximum allowed labels and URLs without throwing", () => {
  const linkBase = "https://example.com/";
  const mediaBase = "https://example.com/";
  const card: DiscordCard = {
    thumbnail: mediaBase + "t".repeat(2_048 - mediaBase.length),
    blocks: [
      {
        kind: "links",
        items: Array.from({ length: 5 }, (_, index) => ({
          label: `${index}`.padEnd(80, "L"),
          url: linkBase + "u".repeat(512 - linkBase.length),
        })),
      },
      {
        kind: "media",
        urls: Array.from({ length: 10 }, () => mediaBase + "m".repeat(2_048 - mediaBase.length)),
      },
      { kind: "text", text: "x".repeat(3_999) },
    ],
  };
  const parsed = parseDiscordCards([card]);
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));

  const json = renderDiscordCards(parsed.cards).components.map((component) => component.toJSON());
  assert.equal(countRenderedComponents(json), countCardComponents(card));
});
