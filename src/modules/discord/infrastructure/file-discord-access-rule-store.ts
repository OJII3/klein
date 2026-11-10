import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

import type {
  DiscordAccess,
  DiscordChannelAccessRule,
  DiscordGuildAccessRule,
} from "../domain/discord-access-policy";
import type {
  DiscordAccessRuleStore,
  DiscordAccessRuleTarget,
} from "../ports/discord-access-rule-store";

const DiscordIdSchema = Type.String({ minLength: 1, pattern: "^[0-9]+$" });
const DiscordAccessSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("owner"),
]);

const DiscordThreadAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
  },
  { additionalProperties: false },
);

const DiscordChannelAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
    threads: Type.Optional(
      Type.Record(DiscordIdSchema, DiscordThreadAccessSchema, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

const DiscordGuildAccessSchema = Type.Object(
  {
    access: Type.Optional(DiscordAccessSchema),
    channels: Type.Optional(
      Type.Record(DiscordIdSchema, DiscordChannelAccessSchema, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

const DiscordAccessFileSchema = Type.Object(
  {
    guilds: Type.Optional(
      Type.Record(DiscordIdSchema, DiscordGuildAccessSchema, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

type DiscordAccessFile = Static<typeof DiscordAccessFileSchema>;

export class FileDiscordAccessRuleStore implements DiscordAccessRuleStore {
  private guilds: Readonly<Record<string, DiscordGuildAccessRule>> = {};
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        this.guilds = {};
        return;
      }

      throw new Error(`Failed to read Discord access rules: ${this.filePath}`, { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Discord access rules are not valid JSON: ${this.filePath}`, {
        cause: error,
      });
    }

    if (!Check(DiscordAccessFileSchema, value)) {
      const errors = Errors(DiscordAccessFileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");

      throw new Error(`Discord access rules are invalid: ${this.filePath}. ${errors}`);
    }

    this.guilds = (value as DiscordAccessFile).guilds ?? {};
  }

  getGuildRule(guildId: string): DiscordGuildAccessRule | undefined {
    return this.guilds[guildId];
  }

  async setAccess(target: DiscordAccessRuleTarget, access: DiscordAccess): Promise<void> {
    const guild = this.guilds[target.guildId] ?? {};
    const channel = guild.channels?.[target.channelId] ?? {};
    const nextChannel: DiscordChannelAccessRule = target.threadId
      ? {
          ...channel,
          threads: {
            ...channel.threads,
            [target.threadId]: { ...channel.threads?.[target.threadId], access },
          },
        }
      : { ...channel, access };

    this.guilds = {
      ...this.guilds,
      [target.guildId]: {
        ...guild,
        channels: { ...guild.channels, [target.channelId]: nextChannel },
      },
    };

    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.persist());
    await this.writeQueue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ guilds: this.guilds }, undefined, 2)}\n`,
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
