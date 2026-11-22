import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

import type { UserEnvironment } from "@shared/user-environment";
import { isFileNotFound, isRecord, parseJson } from "@shared/type-guards";
import { ensureUserEnvironment, resolveUserEnvironment } from "@shared/user-environment";

import {
  SECRET_ENVIRONMENT_ALIAS_PATTERN,
  SECRET_FIELD_KEY_PATTERN,
  SECRET_SERVICE_PATTERN,
  normalizeSecretLabel,
  validateSecretFields,
  type SecretSummary,
  type SecretValues,
} from "../domain/secret";
import type { SecretSaveInput, SecretStore } from "../ports/secret-store";
import {
  SecretCipher,
  secretAdditionalData,
  secretKeyPath,
  type EncryptedSecretPayload,
} from "./secret-cipher";

const SECRET_DIRECTORY = "secrets";

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

const encryptedPayloadSchema = Type.Object(
  {
    algorithm: Type.Literal("aes-256-gcm"),
    iv: Type.String({ minLength: 1 }),
    tag: Type.String({ minLength: 1 }),
    data: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const secretFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    service: Type.String({ minLength: 1, pattern: SECRET_SERVICE_PATTERN.source }),
    label: Type.String({ minLength: 1, maxLength: 80 }),
    fields: Type.Array(fieldSchema, { minItems: 1, maxItems: 5 }),
    updatedAt: Type.String({ minLength: 1 }),
    encryption: encryptedPayloadSchema,
  },
  { additionalProperties: false },
);

interface SecretFile extends SecretSummary {
  readonly version: 1;
  readonly encryption: EncryptedSecretPayload & { readonly algorithm: "aes-256-gcm" };
}

/**
 * Stores one encrypted JSON file per service under the user's secrets
 * directory. The directory and files are owner-only, and the plaintext values
 * never appear in a listing, a log, or the file itself.
 */
export class FileSecretStore implements SecretStore {
  private readonly cipher: SecretCipher;

  constructor(
    private readonly agentDir: string,
    private readonly logger?: Logger,
  ) {
    this.cipher = new SecretCipher(secretKeyPath(agentDir));
  }

  async save(userId: string, input: SecretSaveInput): Promise<SecretSummary> {
    const fieldProblem = validateSecretFields(input.fields);
    if (fieldProblem) throw new Error(fieldProblem);
    if (!SECRET_SERVICE_PATTERN.test(input.service)) {
      throw new Error(`Invalid service name: ${input.service}`);
    }
    const label = normalizeSecretLabel(input.label);
    if (label.length === 0 || label.length > 80) {
      throw new Error("A secret label must be 1 to 80 characters.");
    }

    const fields = input.fields.map((field) => ({
      key: field.key,
      label: normalizeSecretLabel(field.label),
      ...(field.env ? { env: field.env } : {}),
    }));
    const expectedKeys = fields.map((field) => field.key).toSorted();
    const actualKeys = Object.keys(input.values).toSorted();
    if (
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) => key !== actualKeys[index])
    ) {
      throw new Error("Secret values do not match the declared fields.");
    }
    if (!Object.values(input.values).every((value) => typeof value === "string")) {
      throw new Error("Secret values must be strings.");
    }

    const environment = this.resolveEnvironment(userId);
    const directory = this.getDirectory(environment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);

    const file: SecretFile = {
      version: 1,
      service: input.service,
      label,
      fields,
      updatedAt: input.updatedAt,
      encryption: {
        algorithm: "aes-256-gcm",
        ...this.cipher.encrypt(
          JSON.stringify(input.values),
          secretAdditionalData(userId, input.service),
        ),
      },
    };

    const path = this.getFilePath(directory, input.service);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
      if (process.platform !== "win32") await chmod(path, 0o600);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    return toSummary(file);
  }

  async read(userId: string, service: string): Promise<SecretValues | undefined> {
    this.requireService(service);
    const path = this.getFilePath(this.getDirectory(this.resolveEnvironment(userId)), service);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }

    const file = parseSecretFile(raw, path);
    if (file.service !== service) {
      throw new Error(`Secret file service mismatch: ${path}`);
    }

    let value: unknown;
    try {
      value = parseJson(
        this.cipher.decrypt(file.encryption, secretAdditionalData(userId, service)),
      );
    } catch (error) {
      throw new Error(`Failed to decrypt secret: ${service} for ${userId}`, { cause: error });
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(
        value,
        file.fields.map((field) => field.key),
      )
    ) {
      throw new Error(`Secret values are invalid: ${path}`);
    }

    const entries: [string, string][] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        throw new TypeError(`Secret values are invalid: ${path}`);
      }
      entries.push([key, entry]);
    }

    return {
      ...toSummary(file),
      values: Object.fromEntries(entries),
    };
  }

  async list(userId: string): Promise<readonly SecretSummary[]> {
    const directory = this.getDirectory(this.resolveEnvironment(userId));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const summaries: SecretSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = resolve(directory, entry.name);
      try {
        summaries.push(toSummary(parseSecretFile(await readFile(path, "utf8"), path)));
      } catch (error) {
        this.logger?.warn(
          { err: error, event: "secret_file_invalid", userId, path },
          "Skipping an unreadable secret file",
        );
      }
    }
    return summaries.toSorted((left, right) => left.service.localeCompare(right.service));
  }

  async delete(userId: string, service: string): Promise<boolean> {
    this.requireService(service);
    const path = this.getFilePath(this.getDirectory(this.resolveEnvironment(userId)), service);
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
  }

  private resolveEnvironment(userId: string): UserEnvironment {
    return ensureUserEnvironment(resolveUserEnvironment(this.agentDir, userId));
  }

  private getDirectory(environment: UserEnvironment): string {
    return resolve(environment.credentialsDirectory, SECRET_DIRECTORY);
  }

  private getFilePath(directory: string, service: string): string {
    return resolve(directory, `${service}.json`);
  }

  private requireService(service: string): void {
    if (!SECRET_SERVICE_PATTERN.test(service)) {
      throw new Error(`Invalid service name: ${service}`);
    }
  }
}

function toSummary(file: SecretFile): SecretSummary {
  return {
    service: file.service,
    label: file.label,
    fields: file.fields,
    updatedAt: file.updatedAt,
  };
}

function parseSecretFile(raw: string, path: string): SecretFile {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch (error) {
    throw new Error(`Secret file is not valid JSON: ${path}`, { cause: error });
  }
  if (!Check(secretFileSchema, value)) {
    const errors = Errors(secretFileSchema, value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || "$"}: ${error.message}`)
      .join("; ");
    throw new Error(`Secret file is invalid: ${path}. ${errors}`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}
