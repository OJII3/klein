import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  isValidDiscordUserId,
  isValidDiscordUsername,
  normalizeDiscordUsername,
} from "@modules/discord/domain/discord-user";
import {
  clampImpression,
  USER_MEMORY_DEFAULT_SECTION_CONTENT,
  USER_MEMORY_SECTION_HEADINGS,
  USER_MEMORY_SECTION_KEYS,
  type UserMemory,
  type UserMemoryPatch,
  type UserMemorySectionKey,
  type UserMemoryStore,
} from "../domain/user-memory";

const FRONTMATTER_DELIMITER = "---";

export class MarkdownUserMemoryStore implements UserMemoryStore {
  private readonly directory: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async read(userId: string): Promise<UserMemory | undefined> {
    const filePath = this.filePath(userId);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error(`Failed to read user memory file: ${filePath}`, { cause: error });
    }

    try {
      return parseUserMemory(content);
    } catch (error) {
      throw new Error(`Failed to parse user memory file: ${filePath}`, { cause: error });
    }
  }

  async update(userId: string, username: string, patch: UserMemoryPatch): Promise<UserMemory> {
    const normalizedUsername = normalizeDiscordUsername(username);
    if (!isValidDiscordUsername(normalizedUsername)) {
      throw new Error(`Invalid Discord username: ${username}`);
    }
    const filePath = this.filePath(userId);
    return this.runWrite(async () => {
      const existing = await this.read(userId);
      const displayName = normalizeFrontmatterText(
        patch.displayName ?? existing?.displayName ?? "",
      );
      if (!displayName) {
        throw new Error("display_name is required when creating a user memory for the first time.");
      }

      const impression = resolveImpression(existing?.impression ?? 0, patch);
      const nickname = resolveOptionalText(patch.nickname, existing?.nickname);
      const firstName = resolveOptionalText(patch.firstName, existing?.firstName);
      const lastName = resolveOptionalText(patch.lastName, existing?.lastName);
      const memory: UserMemory = {
        discordId: normalizedUsername,
        displayName,
        ...(nickname !== undefined ? { nickname } : {}),
        ...(firstName !== undefined ? { firstName } : {}),
        ...(lastName !== undefined ? { lastName } : {}),
        summary: normalizeFrontmatterText(patch.summary ?? existing?.summary ?? ""),
        impression,
        updatedAt: new Date().toISOString(),
        facts: resolveSection(patch.facts, existing?.facts, "facts"),
        history: resolveSection(patch.history, existing?.history, "history"),
        inCommon: resolveSection(patch.inCommon, existing?.inCommon, "inCommon"),
        strengthening: resolveSection(
          patch.strengthening,
          existing?.strengthening,
          "strengthening",
        ),
      };

      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, renderUserMemory(memory), "utf8");
      await rename(temporaryPath, filePath);
      return memory;
    });
  }

  private filePath(userId: string): string {
    if (!isValidDiscordUserId(userId)) {
      throw new Error(`Invalid Discord user ID: ${userId}`);
    }
    return join(this.directory, `${userId}.md`);
  }

  private runWrite<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

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

function parseUserMemory(content: string): UserMemory {
  const normalized = content.replace(/\r\n?/g, "\n");
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
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function optionalField(fields: Map<string, string>, key: string): string | undefined {
  const value = fields.get(key)?.trim();
  return value ? value : undefined;
}

function resolveOptionalText(
  value: string | null | undefined,
  fallback: string | undefined,
): string | undefined {
  if (value === undefined) {
    if (fallback === undefined) return undefined;
    return normalizeFrontmatterText(fallback) || undefined;
  }
  if (value === null) return undefined;
  const normalized = normalizeFrontmatterText(value);
  return normalized || undefined;
}

function normalizeFrontmatterText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function resolveSection(
  value: string | undefined,
  fallback: string | undefined,
  key: UserMemorySectionKey,
): string {
  if (value === undefined) return fallback ?? USER_MEMORY_DEFAULT_SECTION_CONTENT[key];
  return value.trim() || USER_MEMORY_DEFAULT_SECTION_CONTENT[key];
}

function resolveImpression(current: number, patch: UserMemoryPatch): number {
  if (patch.impression !== undefined && patch.impressionDelta !== undefined) {
    throw new Error("Specify either impression or impression_delta, not both.");
  }
  if (patch.impression !== undefined) return clampImpression(patch.impression);
  if (patch.impressionDelta !== undefined) return clampImpression(current + patch.impressionDelta);
  return current;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
