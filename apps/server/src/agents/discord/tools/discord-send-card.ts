import { Type } from "typebox";

import {
  listCardTexts,
  parseDiscordCards,
  type DiscordCard,
} from "@modules/discord/domain/discord-card";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { PROMISE_BLOCK_ERROR, type PromiseGuard } from "../../tools/promise-guard";
import { defineSurfaceTool } from "./surface-tool";

const blockItemSchema = Type.Object({
  label: Type.Optional(Type.String({ description: "fields/stats/links label." })),
  value: Type.Optional(Type.String({ description: "fields/stats value." })),
  text: Type.Optional(Type.String({ description: "list item text." })),
  detail: Type.Optional(Type.String({ description: "list item detail line." })),
  delta: Type.Optional(Type.String({ description: "stats delta line." })),
  url: Type.Optional(Type.String({ description: "links https URL." })),
});

const blockSchema = Type.Object({
  kind: Type.String({
    description:
      "Block kind: text | fields | list | table | stats | progress | callout | media | links | divider.",
  }),
  text: Type.Optional(Type.String({ description: "text/callout body." })),
  items: Type.Optional(
    Type.Array(blockItemSchema, {
      description:
        "fields: {label,value}; list: {text,detail}; stats: {label,value,delta}; links: {label,url}.",
    }),
  ),
  columns: Type.Optional(Type.Array(Type.String(), { description: "table headers." })),
  rows: Type.Optional(
    Type.Array(Type.Array(Type.String()), {
      description: "table rows; each row needs one cell per column.",
    }),
  ),
  tone: Type.Optional(
    Type.String({ description: "callout tone: info | success | warning | danger." }),
  ),
  label: Type.Optional(Type.String({ description: "progress label." })),
  value: Type.Optional(Type.Number({ description: "progress fill, 0..1." })),
  detail: Type.Optional(Type.String({ description: "progress detail line." })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "media image URLs, 1-10 https." })),
  spoiler: Type.Optional(Type.Boolean({ description: "media spoiler flag." })),
  ordered: Type.Optional(Type.Boolean({ description: "list numbering." })),
});

const cardSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Header line." })),
  subtitle: Type.Optional(Type.String({ description: "Subheader line." })),
  accent: Type.Optional(
    Type.String({ description: "neutral (default) | info | success | warning | danger." }),
  ),
  thumbnail: Type.Optional(Type.String({ description: "https image URL beside the header." })),
  blocks: Type.Array(blockSchema, {
    minItems: 1,
    description: "Content blocks in display order.",
  }),
  footer: Type.Optional(Type.String({ description: "Small closing line." })),
});

export function createDiscordSendCardTool(
  channelApi: Pick<DiscordChannelApi, "sendCard" | "sendTyping">,
  channelId: string,
  guard?: PromiseGuard,
  onMessageSent?: () => void,
) {
  return defineSurfaceTool(
    {
      name: "discord_send_card",
      label: "Send Discord Card",
      exposure: "deferred",
      description:
        "Send structured cards to the current Discord conversation as one components v2 message. " +
        "Cards carry data, never dialogue: say the line with discord_send, then send the card. " +
        "Blocks: text {text}; fields {items}; list {items,ordered}; table {columns,rows}; stats {items}; " +
        "progress {label,value,detail}; callout {tone,text}; media {urls}; links {items}; divider. " +
        "Limits: 40 components and 4000 characters per message; split cards to fit. " +
        'Example: {"cards":[{"title":"Deploys","accent":"info","blocks":[{"kind":"fields","items":[{"label":"Status","value":"green"}]}]}]}',
      parameters: Type.Object({
        cards: Type.Array(cardSchema, { description: "Cards sent as one message." }),
      }),
      async execute(_toolCallId, params) {
        const parsed = parseDiscordCards(params.cards);
        if (!parsed.ok) {
          throw new Error(`The card was not sent.\n${parsed.issues.join("\n")}`);
        }

        for (const card of parsed.cards) {
          for (const text of listCardTexts(card)) {
            const decision = await guard?.check(text);
            if (decision?.action === "block") {
              throw new Error(PROMISE_BLOCK_ERROR);
            }
          }
        }

        await channelApi.sendTyping(channelId);
        const messageIds = await channelApi.sendCard(channelId, parsed.cards);
        onMessageSent?.();

        return {
          content: [{ type: "text", text: describeSentCards(parsed.cards) }],
          details: messageIds.length > 0 ? { messageIds } : {},
        };
      },
    },
    { outcome: "Sent a card to Discord." },
  );
}

function describeSentCards(cards: readonly DiscordCard[]): string {
  const noun = cards.length === 1 ? "a card" : `${cards.length} cards`;
  const titles = cards.flatMap((card) => (card.title === undefined ? [] : [`"${card.title}"`]));
  const titlePart = titles.length > 0 ? `: ${titles.join(", ")}` : "";
  const blockCount = cards.reduce((total, card) => total + card.blocks.length, 0);
  return `Sent ${noun}${titlePart} with ${blockCount} blocks to Discord.`;
}
