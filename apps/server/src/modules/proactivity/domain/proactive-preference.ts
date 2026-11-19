import { parseJapanTime } from "./japan-time";

export type ProactiveDeliveryMode = "interrupt" | "attach" | "digest" | "silent";

export type ProactiveTopicMode = "allow" | "mute" | "urgent-only";

export interface ProactiveDeliveryPreferences {
  readonly defaultMode?: ProactiveDeliveryMode;
  readonly quietHours?: { readonly start: string; readonly end: string };
  readonly digestAt?: string;
  readonly maxPerDay?: number;
}

export interface ProactiveTopicPreference {
  readonly topic: string;
  readonly mode: ProactiveTopicMode;
  readonly until?: string;
}

export interface ProactivePreferences {
  readonly delivery: ProactiveDeliveryPreferences;
  readonly topics: readonly ProactiveTopicPreference[];
  readonly notes: readonly string[];
}

export const DEFAULT_PROACTIVE_PREFERENCES: ProactivePreferences = {
  delivery: {},
  topics: [],
  notes: [],
};

export type ProactivePreferenceChange =
  | {
      readonly kind: "set_delivery";
      readonly key: "default" | "quiet_hours" | "digest_at" | "max_per_day";
      readonly value: string;
    }
  | {
      readonly kind: "set_topic";
      readonly topic: string;
      readonly mode: ProactiveTopicMode;
      readonly until?: string;
    }
  | { readonly kind: "remove_topic"; readonly topic: string }
  | { readonly kind: "add_note"; readonly text: string }
  | { readonly kind: "remove_note"; readonly text: string };

type DeliveryKey = "default" | "quiet_hours" | "digest_at" | "max_per_day";

type SectionName = "delivery" | "topics" | "notes";

interface SectionBounds {
  readonly start: number;
  readonly end: number;
}

interface ParsedDeliveryLine {
  readonly key: DeliveryKey;
  readonly value: string;
}

const TITLE = "# Proactive preferences";

const SECTION_HEADINGS: Readonly<Record<SectionName, string>> = {
  delivery: "Delivery",
  topics: "Topics",
  notes: "Notes",
};

const SECTION_NAMES: readonly SectionName[] = ["delivery", "topics", "notes"];

const DELIVERY_KEYS: readonly DeliveryKey[] = [
  "default",
  "quiet_hours",
  "digest_at",
  "max_per_day",
];

const DELIVERY_MODES: readonly ProactiveDeliveryMode[] = [
  "interrupt",
  "attach",
  "digest",
  "silent",
];

const TOPIC_MODE_LABELS: Readonly<Record<ProactiveTopicMode, string>> = {
  allow: "allow",
  mute: "mute",
  "urgent-only": "allow urgent",
};

export function parseProactivePreferences(markdown: string): ProactivePreferences {
  const delivery: {
    defaultMode?: ProactiveDeliveryMode;
    quietHours?: { readonly start: string; readonly end: string };
    digestAt?: string;
    maxPerDay?: number;
  } = {};
  const topics = new Map<string, ProactiveTopicPreference>();
  const notes: string[] = [];
  let section: SectionName | undefined;

  for (const line of normalizeNewlines(markdown).split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      section = heading[1]?.length === 2 ? findSectionName(heading[2] ?? "") : undefined;
      continue;
    }

    switch (section) {
      case "delivery": {
        const parsed = parseDeliveryLine(line);
        if (!parsed) continue;
        applyDeliveryValue(delivery, parsed.key, parsed.value);
        break;
      }
      case "topics": {
        const parsed = parseTopicLine(line);
        if (parsed) topics.set(normalizeTopic(parsed.topic), parsed);
        break;
      }
      case "notes": {
        const note = parseNoteLine(line);
        if (note !== undefined) notes.push(note);
        break;
      }
      case undefined:
        break;
    }
  }

  return {
    delivery,
    topics: [...topics.values()],
    notes,
  };
}

export function renderProactivePreferences(preferences: ProactivePreferences): string {
  const lines = [TITLE, "", `## ${SECTION_HEADINGS.delivery}`];
  const { delivery } = preferences;
  if (delivery.defaultMode !== undefined) {
    lines.push(`- default: ${delivery.defaultMode}`);
  }
  if (delivery.quietHours !== undefined) {
    lines.push(`- quiet_hours: ${delivery.quietHours.start}-${delivery.quietHours.end}`);
  }
  if (delivery.digestAt !== undefined) {
    lines.push(`- digest_at: ${delivery.digestAt}`);
  }
  if (delivery.maxPerDay !== undefined) {
    lines.push(`- max_per_day: ${delivery.maxPerDay}`);
  }

  lines.push("", `## ${SECTION_HEADINGS.topics}`);
  for (const topic of preferences.topics) {
    lines.push(renderTopicLine(topic));
  }

  lines.push("", `## ${SECTION_HEADINGS.notes}`);
  for (const note of preferences.notes) {
    lines.push(`- ${note}`);
  }

  return `${lines.join("\n")}\n`;
}

export function updateProactivePreferences(
  markdown: string,
  change: ProactivePreferenceChange,
): string {
  const lines = normalizeNewlines(markdown).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) lines.push(TITLE, "");

  switch (change.kind) {
    case "set_delivery": {
      const value = normalizeDeliveryValue(change.key, change.value);
      setDeliveryLine(lines, change.key, value);
      break;
    }
    case "set_topic": {
      const topic = change.topic.trim();
      if (topic.length === 0) throw new Error("話題を指定してください。");
      const until = change.until === undefined ? undefined : normalizeUntil(change.until);
      const line = renderTopicLine({
        topic,
        mode: change.mode,
        ...(until !== undefined ? { until } : {}),
      });
      setTopicLine(lines, topic, line);
      break;
    }
    case "remove_topic": {
      removeTopicLine(lines, change.topic);
      break;
    }
    case "add_note": {
      const note = normalizeInlineText(change.text);
      if (note.length === 0) throw new Error("メモを指定してください。");
      addNoteLine(lines, note);
      break;
    }
    case "remove_note": {
      removeNoteLine(lines, change.text);
      break;
    }
    default: {
      const exhaustive: never = change;
      throw new Error(`好みの変更の種類が不正です: ${String(exhaustive)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function applyDeliveryValue(
  delivery: {
    defaultMode?: ProactiveDeliveryMode;
    quietHours?: { readonly start: string; readonly end: string };
    digestAt?: string;
    maxPerDay?: number;
  },
  key: DeliveryKey,
  value: string,
): void {
  switch (key) {
    case "default": {
      if (isDeliveryMode(value)) delivery.defaultMode = value;
      return;
    }
    case "quiet_hours": {
      const quietHours = parseQuietHours(value);
      if (quietHours) delivery.quietHours = quietHours;
      return;
    }
    case "digest_at": {
      if (isJapanTime(value)) delivery.digestAt = value;
      return;
    }
    case "max_per_day": {
      const maxPerDay = parseMaxPerDay(value);
      if (maxPerDay !== undefined) delivery.maxPerDay = maxPerDay;
      return;
    }
    default: {
      const exhaustive: never = key;
      throw new Error(`好みの項目が不正です: ${String(exhaustive)}`);
    }
  }
}

function parseDeliveryLine(line: string): ParsedDeliveryLine | undefined {
  const match = /^[-*]\s*([^:]+?)\s*:\s*(.*)$/u.exec(line);
  if (!match) return undefined;
  const key = normalizeDeliveryKey(match[1] ?? "");
  if (!key) return undefined;
  return { key, value: (match[2] ?? "").trim() };
}

function normalizeDeliveryKey(value: string): DeliveryKey | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, "_");
  return DELIVERY_KEYS.find((key) => key === normalized);
}

function parseTopicLine(line: string): ProactiveTopicPreference | undefined {
  const match = /^[-*]\s*([^:]+?)\s*:\s*(.*)$/u.exec(line);
  if (!match) return undefined;
  const topic = (match[1] ?? "").trim();
  if (topic.length === 0) return undefined;

  const modeMatch = /^(allow\s+urgent|urgent-only|allow|mute)(?:\s+until\s+(\S+))?$/u.exec(
    (match[2] ?? "").trim(),
  );
  if (!modeMatch) return undefined;

  const until = modeMatch[2];
  if (until !== undefined && !isValidUntil(until)) return undefined;

  return {
    topic,
    mode: parseTopicMode(modeMatch[1] ?? ""),
    ...(until !== undefined ? { until } : {}),
  };
}

function parseTopicMode(value: string): ProactiveTopicMode {
  switch (value) {
    case "mute":
      return "mute";
    case "allow urgent":
    case "urgent-only":
      return "urgent-only";
    default:
      return "allow";
  }
}

function parseNoteLine(line: string): string | undefined {
  const match = /^[-*]\s+(.*)$/u.exec(line);
  if (!match) return undefined;
  const note = (match[1] ?? "").trim();
  return note.length === 0 ? undefined : note;
}

function renderTopicLine(topic: ProactiveTopicPreference): string {
  return `- ${topic.topic}: ${TOPIC_MODE_LABELS[topic.mode]}${
    topic.until !== undefined ? ` until ${topic.until}` : ""
  }`;
}

function normalizeDeliveryValue(key: DeliveryKey, value: string): string {
  switch (key) {
    case "default": {
      const mode = value.trim();
      if (!isDeliveryMode(mode)) {
        throw new Error(
          "配信方法は interrupt, attach, digest, silent のいずれかで指定してください。",
        );
      }
      return mode;
    }
    case "quiet_hours": {
      const quietHours = parseQuietHours(value.trim());
      if (!quietHours) throw new Error("静かな時間は HH:mm-HH:mm で指定してください。");
      return `${quietHours.start}-${quietHours.end}`;
    }
    case "digest_at": {
      const time = value.trim();
      if (!isJapanTime(time)) throw new Error("まとめる時刻は HH:mm で指定してください。");
      return time;
    }
    case "max_per_day": {
      const maxPerDay = parseMaxPerDay(value.trim());
      if (maxPerDay === undefined) throw new Error("1日の上限は0以上の整数で指定してください。");
      return String(maxPerDay);
    }
    default: {
      const exhaustive: never = key;
      throw new Error(`好みの項目が不正です: ${String(exhaustive)}`);
    }
  }
}

function setDeliveryLine(lines: string[], key: DeliveryKey, value: string): void {
  const section = ensureSection(lines, "delivery");
  replaceOrAppend(
    lines,
    section,
    (line) => parseDeliveryLine(line)?.key === key,
    `- ${key}: ${value}`,
  );
}

function setTopicLine(lines: string[], topic: string, newLine: string): void {
  const section = ensureSection(lines, "topics");
  replaceOrAppend(
    lines,
    section,
    (line) => {
      const parsed = parseTopicLine(line);
      return parsed !== undefined && normalizeTopic(parsed.topic) === normalizeTopic(topic);
    },
    newLine,
  );
}

function removeTopicLine(lines: string[], topic: string): void {
  const section = findSection(lines, "topics");
  if (!section) return;
  removeMatching(lines, section, (line) => {
    const parsed = parseTopicLine(line);
    return parsed !== undefined && normalizeTopic(parsed.topic) === normalizeTopic(topic);
  });
}

function addNoteLine(lines: string[], note: string): void {
  const section = ensureSection(lines, "notes");
  replaceOrAppend(
    lines,
    section,
    (line) => {
      const parsed = parseNoteLine(line);
      return parsed !== undefined && normalizeInlineText(parsed) === note;
    },
    `- ${note}`,
  );
}

function removeNoteLine(lines: string[], note: string): void {
  const normalized = normalizeInlineText(note);
  if (normalized.length === 0) return;
  const section = findSection(lines, "notes");
  if (!section) return;
  removeMatching(lines, section, (line) => {
    const parsed = parseNoteLine(line);
    return parsed !== undefined && normalizeInlineText(parsed) === normalized;
  });
}

function replaceOrAppend(
  lines: string[],
  section: SectionBounds,
  matches: (line: string) => boolean,
  newLine: string,
): void {
  const matched: number[] = [];
  for (let index = section.start; index < section.end; index += 1) {
    if (matches(lines[index] ?? "")) matched.push(index);
  }

  const insertIndex = matched[0] ?? contentEnd(lines, section);
  for (const index of matched.toReversed()) {
    lines.splice(index, 1);
  }
  lines.splice(insertIndex, 0, newLine);
}

function removeMatching(
  lines: string[],
  section: SectionBounds,
  matches: (line: string) => boolean,
): void {
  const matched: number[] = [];
  for (let index = section.start; index < section.end; index += 1) {
    if (matches(lines[index] ?? "")) matched.push(index);
  }
  for (const index of matched.toReversed()) {
    lines.splice(index, 1);
  }
}

function ensureSection(lines: string[], name: SectionName): SectionBounds {
  const existing = findSection(lines, name);
  if (existing) return existing;

  if (lines.length > 0 && (lines.at(-1) ?? "").trim().length > 0) {
    lines.push("");
  }
  lines.push(`## ${SECTION_HEADINGS[name]}`);
  return { start: lines.length, end: lines.length };
}

function findSection(lines: readonly string[], name: SectionName): SectionBounds | undefined {
  const heading = `## ${SECTION_HEADINGS[name]}`;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().toLowerCase() !== heading.toLowerCase()) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{1,6}\s+/u.test(lines[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    return { start: index + 1, end };
  }
  return undefined;
}

function contentEnd(lines: readonly string[], section: SectionBounds): number {
  let index = section.end;
  while (index > section.start && (lines[index - 1] ?? "").trim().length === 0) {
    index -= 1;
  }
  return index;
}

function findSectionName(heading: string): SectionName | undefined {
  const normalized = heading.trim().toLowerCase();
  return SECTION_NAMES.find((name) => SECTION_HEADINGS[name].toLowerCase() === normalized);
}

function parseQuietHours(
  value: string,
): { readonly start: string; readonly end: string } | undefined {
  const match = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/u.exec(value);
  if (!match) return undefined;
  const start = match[1] ?? "";
  const end = match[2] ?? "";
  if (!isJapanTime(start) || !isJapanTime(end)) return undefined;
  return { start, end };
}

function isJapanTime(value: string): boolean {
  try {
    parseJapanTime(value);
    return true;
  } catch {
    return false;
  }
}

function parseMaxPerDay(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isDeliveryMode(value: unknown): value is ProactiveDeliveryMode {
  return DELIVERY_MODES.some((mode) => mode === value);
}

function normalizeUntil(value: string): string {
  const until = value.trim();
  if (!isValidUntil(until))
    throw new Error("期限は YYYY-MM-DD または ISO 日時で指定してください。");
  return until;
}

function isValidUntil(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day
    );
  }
  return Number.isFinite(Date.parse(value));
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeInlineText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function normalizeNewlines(value: string): string {
  return value.replaceAll(/\r\n?/gu, "\n");
}
