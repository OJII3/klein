import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";

export class FileDiscordChannelRuleStore implements DiscordChannelRuleStore {
  constructor(private readonly directory: string) {}

  async get(guildId: string, channelId: string): Promise<string | undefined> {
    try {
      const rule = await readFile(this.getFilePath(guildId, channelId), "utf8");
      return rule.trim() || undefined;
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  async set(guildId: string, channelId: string, rule: string): Promise<void> {
    const filePath = this.getFilePath(guildId, channelId);
    const normalizedRule = rule.trim();
    if (!normalizedRule) {
      await unlink(filePath).catch((error: unknown) => {
        if (!isFileNotFound(error)) throw error;
      });
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, normalizedRule, "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private getFilePath(guildId: string, channelId: string): string {
    return resolve(
      this.directory,
      encodeURIComponent(guildId),
      `${encodeURIComponent(channelId)}.txt`,
    );
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
