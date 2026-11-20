import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

import {
  discordChannelLinkLocationKey,
  type DiscordChannelLink,
  type DiscordChannelLinkTarget,
} from "../domain/discord-channel-link";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";

const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });

const DiscordChannelLinkSchema = Type.Object(
  {
    guildId: DiscordIdSchema,
    channelId: DiscordIdSchema,
    threadId: Type.Optional(DiscordIdSchema),
    userId: DiscordIdSchema,
    linkedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const DiscordChannelLinkFileSchema = Type.Object(
  {
    links: Type.Optional(Type.Array(DiscordChannelLinkSchema)),
  },
  { additionalProperties: false },
);

export class FileDiscordChannelLinkStore implements DiscordChannelLinkStore {
  private links = new Map<string, DiscordChannelLink>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        this.links = new Map();
        return;
      }
      throw new Error(`Failed to read Discord channel links: ${this.filePath}`, {
        cause: error,
      });
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Discord channel links are not valid JSON: ${this.filePath}`, {
        cause: error,
      });
    }

    if (!Check(DiscordChannelLinkFileSchema, value)) {
      const errors = Errors(DiscordChannelLinkFileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");
      throw new Error(`Discord channel links are invalid: ${this.filePath}. ${errors}`);
    }

    this.links = new Map(
      (value.links ?? []).map((link) => [discordChannelLinkLocationKey(link), link]),
    );
  }

  getLink(target: DiscordChannelLinkTarget): DiscordChannelLink | undefined {
    return this.links.get(discordChannelLinkLocationKey(target));
  }

  async saveLink(link: DiscordChannelLink): Promise<void> {
    this.links.set(discordChannelLinkLocationKey(link), link);
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.persist());
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ links: [...this.links.values()] }, undefined, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
