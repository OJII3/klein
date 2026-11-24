import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { readJsonRecord } from "@shared/record-file";

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
    const requests = await readJsonRecord(this.filePath, (value) => this.parseFile(value));
    this.requests = new Map((requests ?? []).map((request) => [request.requestId, request]));
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

  private parseFile(value: unknown): R[] {
    if (!Check(this.fileSchema, value)) {
      const errors = Errors(this.fileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");
      throw new Error(`${this.label} are invalid: ${this.filePath}. ${errors}`);
    }
    return readRequests<R>(value, this.requestSchema);
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
