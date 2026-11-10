import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

import type {
  DiscordAccessRequestStore,
  PendingDiscordAccessRequest,
} from "../ports/discord-access-request-store";

const PendingDiscordAccessRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    guildId: Type.String({ minLength: 1 }),
    channelId: Type.String({ minLength: 1 }),
    threadId: Type.Optional(Type.String({ minLength: 1 })),
    pendingChannelId: Type.String({ minLength: 1 }),
    channelName: Type.Optional(Type.String({ minLength: 1 })),
    requesterUserId: Type.String({ minLength: 1 }),
    pendingMessageId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const DiscordAccessRequestFileSchema = Type.Object(
  {
    requests: Type.Optional(Type.Array(PendingDiscordAccessRequestSchema)),
  },
  { additionalProperties: false },
);

type DiscordAccessRequestFile = Static<typeof DiscordAccessRequestFileSchema>;

export class FileDiscordAccessRequestStore implements DiscordAccessRequestStore {
  private requests = new Map<string, PendingDiscordAccessRequest>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        this.requests = new Map();
        return;
      }
      throw new Error(`Failed to read Discord access requests: ${this.filePath}`, {
        cause: error,
      });
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Discord access requests are not valid JSON: ${this.filePath}`, {
        cause: error,
      });
    }

    if (!Check(DiscordAccessRequestFileSchema, value)) {
      const errors = Errors(DiscordAccessRequestFileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");
      throw new Error(`Discord access requests are invalid: ${this.filePath}. ${errors}`);
    }

    this.requests = new Map(
      ((value as DiscordAccessRequestFile).requests ?? []).map((request) => [
        request.requestId,
        request,
      ]),
    );
  }

  list(): readonly PendingDiscordAccessRequest[] {
    return [...this.requests.values()];
  }

  async save(request: PendingDiscordAccessRequest): Promise<void> {
    this.requests.set(request.requestId, request);
    await this.persistQueued();
  }

  async remove(requestId: string): Promise<void> {
    if (!this.requests.delete(requestId)) return;
    await this.persistQueued();
  }

  private persistQueued(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.persist());
    return this.writeQueue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ requests: this.list() }, undefined, 2)}\n`,
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
