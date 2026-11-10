import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";

import type { DiscordUser } from "../domain/discord-message";
import {
  isValidDiscordUserId,
  isValidDiscordUsername,
  normalizeDiscordUsername,
  type DiscordUserResolver,
} from "../domain/discord-user";

export interface KnownDiscordUser extends DiscordUser {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface DiscordUserDocument {
  readonly version: 1;
  readonly users: readonly KnownDiscordUser[];
}

/**
 * Shared username to numeric user ID index for the users Klein has seen in messages.
 * Memory tools resolve @username here, and future mention features can use the same lookup.
 */
export class DiscordUserDirectory implements DiscordUserResolver {
  private readonly filePath: string;
  private readonly logger?: Pick<Logger, "warn">;
  private readonly usersById = new Map<string, KnownDiscordUser>();
  private readonly userIdsByUsername = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, logger?: Pick<Logger, "warn">) {
    this.filePath = resolve(filePath);
    this.logger = logger;
  }

  async load(): Promise<void> {
    this.usersById.clear();
    this.userIdsByUsername.clear();

    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      this.logger?.warn(
        { err: error, event: "discord_user_directory_load_failed" },
        "Failed to read the Discord user directory",
      );
      return;
    }

    try {
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed) || !Array.isArray(parsed.users)) {
        throw new Error("Invalid Discord user directory document");
      }
      for (const entry of parsed.users) {
        const user = parseKnownUser(entry);
        if (user) this.index(user);
      }
    } catch (error) {
      this.logger?.warn(
        { err: error, event: "discord_user_directory_parse_failed" },
        "Failed to parse the Discord user directory",
      );
    }
  }

  remember(user: DiscordUser): void {
    const username = normalizeDiscordUsername(user.username);
    if (!isValidDiscordUserId(user.id) || !isValidDiscordUsername(username)) return;

    const now = new Date().toISOString();
    const existing = this.usersById.get(user.id);
    const known: KnownDiscordUser = {
      id: user.id,
      username,
      displayName: user.displayName,
      bot: user.bot,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };

    if (existing && existing.username !== username) {
      this.userIdsByUsername.delete(existing.username);
    }
    this.index(known);

    if (
      !existing ||
      existing.username !== known.username ||
      existing.displayName !== known.displayName ||
      existing.bot !== known.bot
    ) {
      this.queueSave();
    }
  }

  resolve(username: string): KnownDiscordUser | undefined {
    const normalized = normalizeDiscordUsername(username);
    if (!isValidDiscordUsername(normalized)) return undefined;
    const id = this.userIdsByUsername.get(normalized);
    return id ? this.usersById.get(id) : undefined;
  }

  resolveById(userId: string): KnownDiscordUser | undefined {
    return isValidDiscordUserId(userId) ? this.usersById.get(userId) : undefined;
  }

  list(): readonly KnownDiscordUser[] {
    return [...this.usersById.values()].toSorted((left, right) =>
      left.username.localeCompare(right.username),
    );
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private index(user: KnownDiscordUser): void {
    this.usersById.set(user.id, user);
    this.userIdsByUsername.set(user.username, user.id);
  }

  private queueSave(): void {
    const current = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const document: DiscordUserDocument = {
          version: 1,
          users: this.list(),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.filePath);
      });
    this.writeQueue = current.catch((error) => {
      this.logger?.warn(
        { err: error, event: "discord_user_directory_save_failed" },
        "Failed to save the Discord user directory",
      );
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
