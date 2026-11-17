import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  isValidDiscordUserId,
  isValidDiscordUsername,
  normalizeDiscordUsername,
} from "@modules/discord/domain/discord-user";
import { isFileNotFound } from "@shared/type-guards";
import {
  clampImpression,
  USER_MEMORY_DEFAULT_SECTION_CONTENT,
  type UserMemory,
  type UserMemoryIdentity,
  type UserMemoryPatch,
  type UserMemorySectionKey,
  type UserMemorySummary,
} from "../domain/user-memory";
import { parseUserMemory, renderUserMemory } from "../domain/user-memory-format";
import type {
  UserMemoryEditor,
  UserMemoryReader,
  UserMemoryStore,
} from "../ports/user-memory-store";

export class MarkdownUserMemoryStore
  implements UserMemoryStore, UserMemoryReader, UserMemoryEditor
{
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
      if (isFileNotFound(error)) return undefined;
      throw new Error(`Failed to read user memory file: ${filePath}`, { cause: error });
    }

    try {
      return parseUserMemory(content);
    } catch (error) {
      throw new Error(`Failed to parse user memory file: ${filePath}`, { cause: error });
    }
  }

  async list(): Promise<readonly UserMemorySummary[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new Error(`Failed to list user memory directory: ${this.directory}`, { cause: error });
    }

    const summaries: UserMemorySummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const userId = name.slice(0, -".md".length);
      if (!isValidDiscordUserId(userId)) continue;

      let memory: UserMemory | undefined;
      try {
        memory = await this.read(userId);
      } catch {
        // A malformed file is left out of the listing so it cannot hide every other user.
        continue;
      }
      if (!memory) continue;
      summaries.push({
        userId,
        discordId: memory.discordId,
        displayName: memory.displayName,
        summary: memory.summary,
        impression: memory.impression,
        updatedAt: memory.updatedAt,
      });
    }

    return summaries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async ensure(userId: string, identity: UserMemoryIdentity): Promise<UserMemory> {
    const existing = await this.read(userId);
    if (existing) return existing;

    return this.runWrite(async () => {
      const current = await this.read(userId);
      return current ?? this.writeMemory(userId, identity, {});
    });
  }

  async update(
    userId: string,
    identity: UserMemoryIdentity,
    patch: UserMemoryPatch,
  ): Promise<UserMemory> {
    return this.runWrite(() => this.writeMemory(userId, identity, patch));
  }

  async delete(userId: string): Promise<boolean> {
    const filePath = this.filePath(userId);
    return this.runWrite(async () => {
      try {
        await unlink(filePath);
        return true;
      } catch (error) {
        if (isFileNotFound(error)) return false;
        throw new Error(`Failed to delete user memory file: ${filePath}`, { cause: error });
      }
    });
  }

  private async writeMemory(
    userId: string,
    identity: UserMemoryIdentity,
    patch: UserMemoryPatch,
  ): Promise<UserMemory> {
    const normalizedUsername = normalizeDiscordUsername(identity.username);
    if (!isValidDiscordUsername(normalizedUsername)) {
      throw new Error(`Invalid Discord username: ${identity.username}`);
    }
    const fallbackDisplayName =
      normalizeFrontmatterText(identity.displayName) || normalizedUsername;
    const filePath = this.filePath(userId);
    const existing = await this.read(userId);
    const requestedDisplayName =
      patch.displayName !== undefined ? normalizeFrontmatterText(patch.displayName) : undefined;
    const displayName = requestedDisplayName || existing?.displayName || fallbackDisplayName;

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
      strengthening: resolveSection(patch.strengthening, existing?.strengthening, "strengthening"),
    };

    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, renderUserMemory(memory), "utf8");
    await rename(temporaryPath, filePath);
    return memory;
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
  return value.replaceAll(/\s+/gu, " ").trim();
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
