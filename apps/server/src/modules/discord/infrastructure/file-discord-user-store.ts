import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isFileNotFound, isRecord } from "@shared/type-guards";

import {
  isValidDiscordUserId,
  isValidDiscordUsername,
  normalizeDiscordUsername,
} from "../domain/discord-user";
import type { DiscordUserStore, KnownDiscordUser } from "../ports/discord-user-resolver";

interface DiscordUserDocument {
  readonly version: 1;
  readonly users: readonly KnownDiscordUser[];
}

export class FileDiscordUserStore implements DiscordUserStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(): Promise<readonly KnownDiscordUser[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed.users)) {
      throw new Error("Invalid Discord user directory document");
    }

    const users: KnownDiscordUser[] = [];
    for (const entry of parsed.users) {
      const user = parseKnownUser(entry);
      if (user) users.push(user);
    }
    return users;
  }

  async save(users: readonly KnownDiscordUser[]): Promise<void> {
    const document: DiscordUserDocument = {
      version: 1,
      users,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function parseKnownUser(value: unknown): KnownDiscordUser | undefined {
  if (!isRecord(value)) return undefined;
  const { id, username, displayName, bot, firstSeenAt, lastSeenAt } = value;
  if (typeof id !== "string" || !isValidDiscordUserId(id)) return undefined;
  if (typeof username !== "string") return undefined;
  const normalizedUsername = normalizeDiscordUsername(username);
  if (!isValidDiscordUsername(normalizedUsername)) return undefined;
  if (typeof displayName !== "string") return undefined;
  if (typeof bot !== "boolean") return undefined;
  if (typeof firstSeenAt !== "string" || typeof lastSeenAt !== "string") return undefined;
  return {
    id,
    username: normalizedUsername,
    displayName,
    bot,
    firstSeenAt,
    lastSeenAt,
  };
}
