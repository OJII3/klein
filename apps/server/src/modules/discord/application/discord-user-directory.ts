import type { Logger } from "pino";

import type { DiscordUser } from "../domain/discord-message";
import {
  isValidDiscordUserId,
  isValidDiscordUsername,
  normalizeDiscordUsername,
} from "../domain/discord-user";
import type {
  DiscordUserResolver,
  DiscordUserStore,
  KnownDiscordUser,
} from "../ports/discord-user-resolver";

export type { KnownDiscordUser } from "../ports/discord-user-resolver";

/**
 * Shared username to numeric user ID index for the users Klein has seen in messages.
 * Memory tools resolve @username here, and future mention features can use the same lookup.
 */
export class DiscordUserDirectory implements DiscordUserResolver {
  private readonly store: DiscordUserStore;
  private readonly logger?: Pick<Logger, "warn">;
  private readonly usersById = new Map<string, KnownDiscordUser>();
  private readonly userIdsByUsername = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(store: DiscordUserStore, logger?: Pick<Logger, "warn">) {
    this.store = store;
    this.logger = logger;
  }

  async load(): Promise<void> {
    this.usersById.clear();
    this.userIdsByUsername.clear();

    try {
      const users = await this.store.load();
      for (const user of users) {
        if (isValidDiscordUserId(user.id) && isValidDiscordUsername(user.username)) {
          this.index(user);
        }
      }
    } catch (error) {
      this.logger?.warn(
        { err: error, event: "discord_user_directory_load_failed" },
        "Failed to load the Discord user directory",
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
    const save = async (): Promise<void> => {
      await this.writeQueue.catch(() => undefined);
      await this.store.save(this.list());
    };
    this.writeQueue = save().catch((error: unknown) => {
      this.logger?.warn(
        { err: error, event: "discord_user_directory_save_failed" },
        "Failed to save the Discord user directory",
      );
    });
  }
}
