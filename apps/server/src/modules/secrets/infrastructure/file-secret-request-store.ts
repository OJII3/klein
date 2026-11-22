import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

import { parseAccessScope } from "@shared/access";
import { isFileNotFound, parseJson } from "@shared/type-guards";

import {
  SECRET_ENVIRONMENT_ALIAS_PATTERN,
  SECRET_FIELD_KEY_PATTERN,
  SECRET_SERVICE_PATTERN,
} from "../domain/secret";
import type { SecretRequest } from "../domain/secret-request";
import type { SecretRequestStore } from "../ports/secret-request-store";

const fieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 32, pattern: SECRET_FIELD_KEY_PATTERN.source }),
    label: Type.String({ minLength: 1, maxLength: 45 }),
    env: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: SECRET_ENVIRONMENT_ALIAS_PATTERN.source,
      }),
    ),
  },
  { additionalProperties: false },
);

const requestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    userId: Type.String({ minLength: 1 }),
    channelId: Type.String({ minLength: 1 }),
    accessScope: Type.String({ pattern: "^(owner|user):" }),
    workerId: Type.String({ minLength: 1 }),
    service: Type.String({ minLength: 1, pattern: SECRET_SERVICE_PATTERN.source }),
    label: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    fields: Type.Array(fieldSchema, { minItems: 1, maxItems: 5 }),
    createdAt: Type.String({ minLength: 1 }),
    expiresAt: Type.String({ minLength: 1 }),
    dmChannelId: Type.Optional(Type.String({ minLength: 1 })),
    dmMessageId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const fileSchema = Type.Object(
  { requests: Type.Array(requestSchema) },
  { additionalProperties: false },
);

/** A single owner-only file of pending requests; it never contains a secret value. */
export class FileSecretRequestStore implements SecretRequestStore {
  private requests = new Map<string, SecretRequest>();
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
      throw new Error(`Failed to read secret requests: ${this.filePath}`, { cause: error });
    }

    let value: unknown;
    try {
      value = parseJson(content);
    } catch (error) {
      throw new Error(`Secret requests are not valid JSON: ${this.filePath}`, { cause: error });
    }
    if (!Check(fileSchema, value)) {
      const errors = Errors(fileSchema, value)
        .slice(0, 5)
        .map((error) => `${error.instancePath || "$"}: ${error.message}`)
        .join("; ");
      throw new Error(`Secret requests are invalid: ${this.filePath}. ${errors}`);
    }
    const requests = value.requests.flatMap((request) => {
      const accessScope = parseAccessScope(request.accessScope);
      return accessScope ? [{ ...request, accessScope }] : [];
    });
    this.requests = new Map(requests.map((request) => [request.requestId, request]));
  }

  list(): readonly SecretRequest[] {
    return [...this.requests.values()];
  }

  async save(request: SecretRequest): Promise<void> {
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
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ requests: this.list() }, undefined, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") await chmod(this.filePath, 0o600);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
