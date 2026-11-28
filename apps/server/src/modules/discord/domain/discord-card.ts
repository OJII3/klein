import { DISCORD_TEXT_DISPLAY_LIMIT } from "./discord-text";

export const DISCORD_CARD_COMPONENT_LIMIT = 40;

export type DiscordCardAccent = "neutral" | "info" | "success" | "warning" | "danger";

export type DiscordCardCalloutTone = "info" | "success" | "warning" | "danger";

export const DISCORD_CARD_BLOCK_KINDS = [
  "text",
  "fields",
  "list",
  "table",
  "stats",
  "progress",
  "callout",
  "media",
  "links",
  "divider",
] as const;

export type DiscordCardBlockKind = (typeof DISCORD_CARD_BLOCK_KINDS)[number];

export interface DiscordCardField {
  readonly label: string;
  readonly value: string;
}

export interface DiscordCardListItem {
  readonly text: string;
  readonly detail?: string;
}

export interface DiscordCardStat {
  readonly label: string;
  readonly value: string;
  readonly delta?: string;
}

export interface DiscordCardLink {
  readonly label: string;
  readonly url: string;
}

export type DiscordCardBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "fields"; readonly items: readonly DiscordCardField[] }
  | {
      readonly kind: "list";
      readonly items: readonly DiscordCardListItem[];
      readonly ordered?: boolean;
    }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "stats"; readonly items: readonly DiscordCardStat[] }
  | {
      readonly kind: "progress";
      readonly label: string;
      readonly value: number;
      readonly detail?: string;
    }
  | { readonly kind: "callout"; readonly tone: DiscordCardCalloutTone; readonly text: string }
  | { readonly kind: "media"; readonly urls: readonly string[]; readonly spoiler?: boolean }
  | { readonly kind: "links"; readonly items: readonly DiscordCardLink[] }
  | { readonly kind: "divider" };

export interface DiscordCard {
  readonly title?: string;
  readonly subtitle?: string;
  readonly accent?: DiscordCardAccent;
  readonly thumbnail?: string;
  readonly blocks: readonly DiscordCardBlock[];
  readonly footer?: string;
}

export type DiscordCardParseResult =
  | { readonly ok: true; readonly cards: readonly DiscordCard[] }
  | { readonly ok: false; readonly issues: readonly string[] };

export function parseDiscordCards(input: unknown): DiscordCardParseResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      issues: ["cards: expected an array of card objects. Send at least one card."],
    };
  }
  const rawCards: readonly unknown[] = input;
  if (rawCards.length === 0) {
    return { ok: false, issues: ["cards: expected at least one card. Send one card per message."] };
  }

  const context: ParseContext = { issues: [] };
  const cards = rawCards.flatMap((value, index) => {
    const card = parseCard(value, `cards[${index}]`, context);
    return card === undefined ? [] : [card];
  });
  if (context.issues.length > 0) return { ok: false, issues: context.issues };

  const components = cards.reduce((total, card) => total + countCardComponents(card), 0);
  if (components > DISCORD_CARD_COMPONENT_LIMIT) {
    return {
      ok: false,
      issues: [
        `cards: ${components} components exceed Discord's ${DISCORD_CARD_COMPONENT_LIMIT}-component limit for one message. Drop ${components - DISCORD_CARD_COMPONENT_LIMIT} components or split the cards into two messages.`,
      ],
    };
  }

  const characters = cards.reduce((total, card) => total + countCardText(card), 0);
  if (characters > DISCORD_TEXT_DISPLAY_LIMIT) {
    return {
      ok: false,
      issues: [
        `cards: ${characters} characters across text displays exceed Discord's ${DISCORD_TEXT_DISPLAY_LIMIT}-character limit for one message. Shorten the text by ${characters - DISCORD_TEXT_DISPLAY_LIMIT} characters or split the cards into two messages.`,
      ],
    };
  }

  return { ok: true, cards };
}

export function countCardComponents(card: DiscordCard): number {
  let total = 1;
  if (hasCardHeader(card)) {
    total += card.thumbnail === undefined ? 1 : 3;
  }
  for (const block of card.blocks) {
    total += countBlockComponents(block);
  }
  if (card.footer !== undefined) total += 1;
  return total;
}

export function countCardText(card: DiscordCard): number {
  let total = 0;
  if (hasCardHeader(card)) total += formatCardHeader(card).length;
  for (const block of card.blocks) {
    total += formatCardBlockText(block)?.length ?? 0;
  }
  if (card.footer !== undefined) total += formatCardFooter(card.footer).length;
  return total;
}

export function listCardTexts(card: DiscordCard): readonly string[] {
  const texts: string[] = [];
  if (card.title !== undefined) texts.push(card.title);
  if (card.subtitle !== undefined) texts.push(card.subtitle);
  if (card.footer !== undefined) texts.push(card.footer);
  for (const block of card.blocks) {
    switch (block.kind) {
      case "text":
        texts.push(block.text);
        break;
      case "fields":
        for (const item of block.items) texts.push(item.label, item.value);
        break;
      case "list":
        for (const item of block.items) {
          texts.push(item.text);
          if (item.detail !== undefined) texts.push(item.detail);
        }
        break;
      case "table":
        texts.push(...block.columns);
        for (const row of block.rows) texts.push(...row);
        break;
      case "stats":
        for (const item of block.items) {
          texts.push(item.label, item.value);
          if (item.delta !== undefined) texts.push(item.delta);
        }
        break;
      case "progress":
        texts.push(block.label);
        if (block.detail !== undefined) texts.push(block.detail);
        break;
      case "callout":
        texts.push(block.text);
        break;
      case "media":
        break;
      case "links":
        for (const item of block.items) texts.push(item.label);
        break;
      case "divider":
        break;
    }
  }
  return texts;
}

export function formatCardHeader(card: Pick<DiscordCard, "title" | "subtitle">): string {
  const lines: string[] = [];
  if (card.title !== undefined) lines.push(`### ${card.title}`);
  if (card.subtitle !== undefined) lines.push(`-# ${card.subtitle}`);
  return lines.length > 0 ? lines.join("\n") : "\u200b";
}

export function formatCardFooter(footer: string): string {
  return `-# ${footer}`;
}

export function formatCardBlockText(block: DiscordCardBlock): string | undefined {
  switch (block.kind) {
    case "text":
      return block.text;
    case "fields":
      return block.items.map((item) => `**${item.label}**\u2002${item.value}`).join("\n");
    case "list":
      return block.items
        .flatMap((item, index) => {
          const marker = block.ordered === true ? `${index + 1}.` : "•";
          return item.detail === undefined
            ? [`${marker} ${item.text}`]
            : [`${marker} ${item.text}`, `-# ${item.detail}`];
        })
        .join("\n");
    case "table":
      return formatCardTable(block.columns, block.rows);
    case "stats":
      return block.items
        .flatMap((item) => [
          `**${item.value}** ${item.label}`,
          ...(item.delta === undefined ? [] : [`-# ${item.delta}`]),
        ])
        .join("\n");
    case "progress":
      return formatCardProgress(block.label, block.value, block.detail);
    case "callout":
      return formatCardCallout(block.tone, block.text);
    case "media":
    case "links":
    case "divider":
      return undefined;
    default:
      return assertNever(block);
  }
}

export const TABLE_COLUMN_LIMIT = 6;
export const TABLE_ROW_LIMIT = 20;
export const TABLE_CELL_WIDTH_LIMIT = 20;

export function formatCardTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const headers = columns.slice(0, TABLE_COLUMN_LIMIT).map((column) => toTableCell(column));
  const visibleRows = rows
    .slice(0, TABLE_ROW_LIMIT)
    .map((row) => row.slice(0, TABLE_COLUMN_LIMIT).map((cell) => toTableCell(cell)));
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...visibleRows.map((row) => displayWidth(row[index] ?? ""))),
  );
  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => padToDisplayWidth(cell, widths[index] ?? 0))
      .join("  ")
      .trimEnd();

  const lines = [formatRow(headers), ...visibleRows.map((row) => formatRow(row))];
  const hiddenRows = rows.length - visibleRows.length;
  if (hiddenRows > 0) lines.push(`…ほか ${hiddenRows} 行`);

  return ["```", ...lines, "```"].join("\n");
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isWideCharacter(character) ? 2 : 1;
  }
  return width;
}

const WIDE_BMP =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;
const WIDE_ASTRAL = /[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

function isWideCharacter(character: string): boolean {
  return WIDE_BMP.test(character) || WIDE_ASTRAL.test(character);
}

function toTableCell(cell: string): string {
  const sanitized = cell.replaceAll("`", "'").replaceAll("\r", " ").replaceAll("\n", " ");
  let text = "";
  let width = 0;
  for (const character of sanitized) {
    const characterWidth = isWideCharacter(character) ? 2 : 1;
    if (width + characterWidth > TABLE_CELL_WIDTH_LIMIT - 1) return `${text}…`;
    text += character;
    width += characterWidth;
  }
  return text;
}

function padToDisplayWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

const CALLOUT_EMOJI: Readonly<Record<DiscordCardCalloutTone, string>> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  danger: "⛔",
};

function formatCardCallout(tone: DiscordCardCalloutTone, text: string): string {
  const emoji = CALLOUT_EMOJI[tone];
  const [first = "", ...rest] = text.split("\n");
  return [`> ${emoji} ${first}`, ...rest.map((line) => `> ${line}`)].join("\n");
}

const PROGRESS_CELLS = 10;

function formatCardProgress(label: string, value: number, detail?: string): string {
  const filled = Math.round(value * PROGRESS_CELLS);
  const bar = `${"█".repeat(filled)}${"░".repeat(PROGRESS_CELLS - filled)}`;
  const line = `${label} ${bar} ${Math.round(value * 100)}%`;
  return detail === undefined ? line : `${line}\n-# ${detail}`;
}

function hasCardHeader(card: DiscordCard): boolean {
  return card.title !== undefined || card.subtitle !== undefined || card.thumbnail !== undefined;
}

function countBlockComponents(block: DiscordCardBlock): number {
  switch (block.kind) {
    case "media":
      return 1;
    case "links":
      return 1 + block.items.length;
    case "text":
    case "fields":
    case "list":
    case "table":
    case "stats":
    case "progress":
    case "callout":
    case "divider":
      return 1;
    default:
      return assertNever(block);
  }
}

interface ParseContext {
  readonly issues: string[];
}

function parseCard(value: unknown, path: string, context: ParseContext): DiscordCard | undefined {
  if (!isRecord(value)) {
    addIssue(context, path, "expected a card object with a blocks array.");
    return undefined;
  }
  const issuesBefore = context.issues.length;

  const title = optionalText(value.title, `${path}.title`, context);
  const subtitle = optionalText(value.subtitle, `${path}.subtitle`, context);
  const footer = optionalText(value.footer, `${path}.footer`, context);
  const accent = parseAccent(value.accent, `${path}.accent`, context);
  const thumbnail =
    value.thumbnail === undefined
      ? undefined
      : parseHttpsUrl(value.thumbnail, `${path}.thumbnail`, context);
  const blocks = parseBlocks(value.blocks, `${path}.blocks`, context);

  if (blocks === undefined) return undefined;

  if (
    context.issues.length === issuesBefore &&
    title === undefined &&
    subtitle === undefined &&
    thumbnail === undefined &&
    footer === undefined &&
    blocks.every((block) => block.kind === "divider")
  ) {
    addIssue(context, path, "has no content. Add a title, text, media, links, or a content block.");
    return undefined;
  }

  return {
    ...(title === undefined ? {} : { title }),
    ...(subtitle === undefined ? {} : { subtitle }),
    accent,
    ...(thumbnail === undefined ? {} : { thumbnail }),
    blocks,
    ...(footer === undefined ? {} : { footer }),
  };
}

function parseBlocks(
  value: unknown,
  path: string,
  context: ParseContext,
): DiscordCardBlock[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(context, path, "expected an array of blocks.");
    return undefined;
  }
  const rawBlocks: readonly unknown[] = value;
  if (rawBlocks.length === 0) {
    addIssue(context, path, "expected at least one block. Add a block or do not send the card.");
    return undefined;
  }

  return rawBlocks.flatMap((entry, index) => {
    const block = parseBlock(entry, `${path}[${index}]`, context);
    return block === undefined ? [] : [block];
  });
}

function parseBlock(
  value: unknown,
  path: string,
  context: ParseContext,
): DiscordCardBlock | undefined {
  if (!isRecord(value)) {
    addIssue(context, path, "expected a block object with a kind.");
    return undefined;
  }
  if (!isBlockKind(value.kind)) {
    addIssue(
      context,
      path,
      `unknown block kind ${describeValue(value.kind)}. Use one of: ${DISCORD_CARD_BLOCK_KINDS.join(", ")}.`,
    );
    return undefined;
  }

  const kind = value.kind;
  const blockPath = `${path} (${kind})`;

  switch (kind) {
    case "text": {
      const text = requireText(value.text, `${blockPath}.text`, context, "expected the text body.");
      return text === undefined ? undefined : { kind, text };
    }
    case "fields": {
      const items = parseItems(
        value.items,
        `${blockPath}.items`,
        context,
        "field",
        (item, itemPath) => {
          if (!isRecord(item)) {
            addIssue(context, itemPath, "expected an object with label and value.");
            return undefined;
          }
          const label = requireText(
            item.label,
            `${itemPath}.label`,
            context,
            "expected a field label.",
          );
          const fieldValue = requireText(
            item.value,
            `${itemPath}.value`,
            context,
            "expected a field value.",
          );
          return label === undefined || fieldValue === undefined
            ? undefined
            : { label, value: fieldValue };
        },
      );
      return items === undefined ? undefined : { kind, items };
    }
    case "list": {
      const items = parseItems(
        value.items,
        `${blockPath}.items`,
        context,
        "list item",
        (item, itemPath) => {
          if (!isRecord(item)) {
            addIssue(context, itemPath, "expected an object with text and an optional detail.");
            return undefined;
          }
          const text = requireText(
            item.text,
            `${itemPath}.text`,
            context,
            "expected the item text.",
          );
          const detail = optionalText(item.detail, `${itemPath}.detail`, context);
          return text === undefined
            ? undefined
            : { text, ...(detail === undefined ? {} : { detail }) };
        },
      );
      if (items === undefined) return undefined;
      return { kind, items, ...(value.ordered === true ? { ordered: true } : {}) };
    }
    case "table": {
      const columns = parseColumns(value.columns, `${blockPath}.columns`, context);
      if (columns === undefined) return undefined;
      if (!Array.isArray(value.rows)) {
        addIssue(context, `${blockPath}.rows`, "expected an array of rows.");
        return undefined;
      }
      const rawRows: readonly unknown[] = value.rows;
      const rows = rawRows.flatMap((row, rowIndex) => {
        if (!Array.isArray(row)) {
          addIssue(context, `${blockPath}.rows[${rowIndex}]`, "expected an array of cells.");
          return [];
        }
        const cells: readonly unknown[] = row;
        if (cells.length !== columns.length) {
          addIssue(
            context,
            blockPath,
            `rows[${rowIndex}] has ${cells.length} cells but columns has ${columns.length}. Pad the row or drop the cell.`,
          );
          return [];
        }
        return [cells.map((cell) => (typeof cell === "string" ? cell : String(cell)))];
      });
      return { kind, columns, rows };
    }
    case "stats": {
      const items = parseItems(
        value.items,
        `${blockPath}.items`,
        context,
        "stat",
        (item, itemPath) => {
          if (!isRecord(item)) {
            addIssue(
              context,
              itemPath,
              "expected an object with label, value, and an optional delta.",
            );
            return undefined;
          }
          const label = requireText(
            item.label,
            `${itemPath}.label`,
            context,
            "expected a stat label.",
          );
          const statValue = requireText(
            item.value,
            `${itemPath}.value`,
            context,
            "expected a stat value.",
          );
          const delta = optionalText(item.delta, `${itemPath}.delta`, context);
          return label === undefined || statValue === undefined
            ? undefined
            : { label, value: statValue, ...(delta === undefined ? {} : { delta }) };
        },
      );
      return items === undefined ? undefined : { kind, items };
    }
    case "progress": {
      const label = requireText(
        value.label,
        `${blockPath}.label`,
        context,
        "expected a progress label.",
      );
      if (
        typeof value.value !== "number" ||
        !Number.isFinite(value.value) ||
        value.value < 0 ||
        value.value > 1
      ) {
        addIssue(
          context,
          `${blockPath}.value`,
          `expected a number between 0 and 1, got ${describeValue(value.value)}. Use the fraction (0.62), not the percentage.`,
        );
        return undefined;
      }
      const detail = optionalText(value.detail, `${blockPath}.detail`, context);
      return label === undefined
        ? undefined
        : { kind, label, value: value.value, ...(detail === undefined ? {} : { detail }) };
    }
    case "callout": {
      if (
        value.tone !== "info" &&
        value.tone !== "success" &&
        value.tone !== "warning" &&
        value.tone !== "danger"
      ) {
        addIssue(
          context,
          `${blockPath}.tone`,
          `expected one of info, success, warning, danger, got ${describeValue(value.tone)}.`,
        );
        return undefined;
      }
      const text = requireText(
        value.text,
        `${blockPath}.text`,
        context,
        "expected the callout text.",
      );
      return text === undefined ? undefined : { kind, tone: value.tone, text };
    }
    case "media": {
      if (!Array.isArray(value.urls)) {
        addIssue(context, `${blockPath}.urls`, "expected an array of image URLs.");
        return undefined;
      }
      const rawUrls: readonly unknown[] = value.urls;
      if (rawUrls.length === 0) {
        addIssue(context, `${blockPath}.urls`, "expected at least one image URL.");
        return undefined;
      }
      if (rawUrls.length > 10) {
        addIssue(
          context,
          `${blockPath}.urls`,
          `${rawUrls.length} URLs exceed the 10-item limit of one media gallery. Split them into multiple media blocks.`,
        );
        return undefined;
      }
      const urls = rawUrls.flatMap((url, index) => {
        const parsed = parseHttpsUrl(url, `${blockPath}.urls[${index}]`, context);
        return parsed === undefined ? [] : [parsed];
      });
      if (value.spoiler !== undefined && typeof value.spoiler !== "boolean") {
        addIssue(context, `${blockPath}.spoiler`, "expected true or false.");
        return undefined;
      }
      return {
        kind,
        urls,
        ...(value.spoiler === true ? { spoiler: true } : {}),
      };
    }
    case "links": {
      const items = parseItems(
        value.items,
        `${blockPath}.items`,
        context,
        "link",
        (item, itemPath) => {
          if (!isRecord(item)) {
            addIssue(context, itemPath, "expected an object with label and url.");
            return undefined;
          }
          const label = requireText(
            item.label,
            `${itemPath}.label`,
            context,
            "expected a link label.",
          );
          const url = parseHttpsUrl(item.url, `${itemPath}.url`, context);
          return label === undefined || url === undefined ? undefined : { label, url };
        },
      );
      if (items === undefined) return undefined;
      if (items.length > 5) {
        const extras = items.length - 5;
        addIssue(
          context,
          `${blockPath}.items`,
          `${items.length} links exceed the 5-button limit of one action row. Split them into two links blocks or drop ${extras === 1 ? "one link" : `${extras} links`}.`,
        );
        return undefined;
      }
      return { kind, items };
    }
    case "divider":
      return { kind };
    default:
      return assertNever(kind);
  }
}

function parseColumns(value: unknown, path: string, context: ParseContext): string[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(context, path, "expected an array of column headers.");
    return undefined;
  }
  const rawColumns: readonly unknown[] = value;
  if (rawColumns.length === 0) {
    addIssue(context, path, "expected at least one column header.");
    return undefined;
  }
  const columns = rawColumns.flatMap((column, index) => {
    const text = requireText(column, `${path}[${index}]`, context, "expected a column header.");
    return text === undefined ? [] : [text];
  });
  return columns.length === rawColumns.length ? columns : undefined;
}

function parseItems<T>(
  value: unknown,
  path: string,
  context: ParseContext,
  noun: string,
  parseItem: (item: unknown, itemPath: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(context, path, `expected an array of ${noun}s.`);
    return undefined;
  }
  const rawItems: readonly unknown[] = value;
  if (rawItems.length === 0) {
    addIssue(context, path, `expected at least one ${noun}.`);
    return undefined;
  }
  const items = rawItems.flatMap((item, index) => {
    const parsed = parseItem(item, `${path}[${index}]`);
    return parsed === undefined ? [] : [parsed];
  });
  return items.length === rawItems.length ? items : undefined;
}

function parseAccent(value: unknown, path: string, context: ParseContext): DiscordCardAccent {
  if (value === undefined) return "neutral";
  if (
    value === "neutral" ||
    value === "info" ||
    value === "success" ||
    value === "warning" ||
    value === "danger"
  ) {
    return value;
  }
  addIssue(
    context,
    path,
    `expected one of neutral, info, success, warning, danger, got ${describeValue(value)}.`,
  );
  return "neutral";
}

function parseHttpsUrl(value: unknown, path: string, context: ParseContext): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    addIssue(context, path, "expected a non-empty https URL.");
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    addIssue(
      context,
      path,
      `${describeValue(value)} is not a valid URL. Use an absolute https URL.`,
    );
    return undefined;
  }
  if (url.protocol === "http:") {
    addIssue(
      context,
      path,
      "only https URLs are accepted; http: URLs are rejected. Change the URL scheme to https.",
    );
    return undefined;
  }
  if (url.protocol !== "https:") {
    addIssue(
      context,
      path,
      `only https URLs are accepted, not ${describeValue(url.protocol)}. Change the URL scheme to https.`,
    );
    return undefined;
  }
  return value;
}

function requireText(
  value: unknown,
  path: string,
  context: ParseContext,
  expectation: string,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(context, path, `${expectation} as a non-empty string.`);
    return undefined;
  }
  return value;
}

function optionalText(value: unknown, path: string, context: ParseContext): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(context, path, "expected a non-empty string. Provide text or drop the field.");
    return undefined;
  }
  return value;
}

function isBlockKind(value: unknown): value is DiscordCardBlockKind {
  return typeof value === "string" && DISCORD_CARD_BLOCK_KINDS.some((kind) => kind === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "nothing";
  return JSON.stringify(value) ?? "an unsupported value";
}

function addIssue(context: ParseContext, path: string, message: string): void {
  context.issues.push(`${path}: ${message}`);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled card block kind: ${JSON.stringify(value)}`);
}
