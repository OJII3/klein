import {
  isValidDiscordUsername,
  normalizeDiscordUsername,
} from "@modules/discord/domain/discord-user";
import {
  clampImpression,
  USER_MEMORY_DEFAULT_SECTION_CONTENT,
  USER_MEMORY_SECTION_HEADINGS,
  USER_MEMORY_SECTION_KEYS,
  type UserMemory,
  type UserMemorySectionKey,
} from "./user-memory";

const FRONTMATTER_DELIMITER = "---";

export function renderUserMemory(memory: UserMemory): string {
  const lines = [
    FRONTMATTER_DELIMITER,
    `discord_id: ${quote(memory.discordId)}`,
    `display_name: ${quote(memory.displayName)}`,
    ...(memory.nickname !== undefined ? [`nickname: ${quote(memory.nickname)}`] : []),
    ...(memory.firstName !== undefined ? [`first_name: ${quote(memory.firstName)}`] : []),
    ...(memory.lastName !== undefined ? [`last_name: ${quote(memory.lastName)}`] : []),
    `summary: ${quote(memory.summary)}`,
    `impression: ${memory.impression}`,
    `updated_at: ${quote(memory.updatedAt)}`,
    FRONTMATTER_DELIMITER,
    "",
  ];

  for (const key of USER_MEMORY_SECTION_KEYS) {
    lines.push(`## ${USER_MEMORY_SECTION_HEADINGS[key]}`, "", memory[key], "");
  }

  return lines.join("\n");
}

export function parseUserMemory(content: string): UserMemory {
  const normalized = content.replaceAll(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error("Front matter is missing");
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error("Front matter is not closed");
  }

  const fields = parseFrontmatter(lines.slice(1, endIndex));
  const discordId = normalizeDiscordUsername(fields.get("discord_id") ?? "");
  if (!isValidDiscordUsername(discordId)) {
    throw new Error("discord_id is missing or invalid in front matter");
  }

  const displayName = fields.get("display_name")?.trim();
  if (!displayName) {
    throw new Error("display_name is missing from front matter");
  }

  const sections = parseSections(lines.slice(endIndex + 1).join("\n"));
  const nickname = optionalField(fields, "nickname");
  const firstName = optionalField(fields, "first_name");
  const lastName = optionalField(fields, "last_name");
  return {
    discordId,
    displayName,
    ...(nickname !== undefined ? { nickname } : {}),
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    summary: fields.get("summary") ?? "",
    impression: clampImpression(Number.parseInt(fields.get("impression") ?? "0", 10)),
    updatedAt: fields.get("updated_at") ?? "",
    ...sections,
  };
}

function parseFrontmatter(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim(), parseScalar(line.slice(separator + 1).trim()));
  }
  return fields;
}

function parseSections(body: string): Record<UserMemorySectionKey, string> {
  const sections: Record<UserMemorySectionKey, string> = {
    facts: "",
    history: "",
    inCommon: "",
    strengthening: "",
  };
  let current: UserMemorySectionKey | undefined;

  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = findSectionKey(heading[1] ?? "");
      continue;
    }
    if (current) sections[current] += `${line}\n`;
  }

  for (const key of USER_MEMORY_SECTION_KEYS) {
    sections[key] = sections[key].trim() || USER_MEMORY_DEFAULT_SECTION_CONTENT[key];
  }
  return sections;
}

function findSectionKey(heading: string): UserMemorySectionKey | undefined {
  const normalized = heading.toLowerCase();
  return USER_MEMORY_SECTION_KEYS.find(
    (key) => USER_MEMORY_SECTION_HEADINGS[key].toLowerCase() === normalized,
  );
}

function parseScalar(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

function optionalField(fields: Map<string, string>, key: string): string | undefined {
  const value = fields.get(key)?.trim();
  return value ? value : undefined;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
