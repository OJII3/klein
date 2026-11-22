import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { DiscordApprovalRequest } from "../domain/discord-approval-request";
import type { DiscordApprovalRequestStore } from "../ports/discord-approval-request-store";

export class FileDiscordApprovalRequestStore<
  R extends DiscordApprovalRequest,
> implements DiscordApprovalRequestStore<R> {
  private requests = new Map<string, R>();
  private readonly fileSchema: TSchema;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly requestSchema: TSchema,
    private readonly label: string,
  ) {
    this.fileSchema = Type.Object(
      { requests: Type.Optional(Type.Array(requestSchema)) },
      { additionalProperties: false },
    );
  }

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        this.requests = new Map();
        return;
      }
      throw new Error(`Failed to read ${this.label}: ${this.filePath}`, { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`${this.label} are not valid JSON: ${this.filePath}`, { cause: error });
    }

    if (!Check(this.fileSchema, value)) {
      const errors = Errors(this.fileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");
      throw new Error(`${this.label} are invalid: ${this.filePath}. ${errors}`);
    }

    const requests = readRequests<R>(value, this.requestSchema);
    this.requests = new Map(requests.map((request) => [request.requestId, request]));
  }

  list(): readonly R[] {
    return [...this.requests.values()];
  }

  async save(request: R): Promise<void> {
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

function readRequests<R extends DiscordApprovalRequest>(value: unknown, schema: TSchema): R[] {
  if (typeof value !== "object" || value === null || !("requests" in value)) return [];
  const requests = value.requests;
  if (!Array.isArray(requests)) return [];
  return requests.filter((request): request is R => Check(schema, request));
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
