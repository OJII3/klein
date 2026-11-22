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
  AUTH_ENVIRONMENT_ALIAS_PATTERN,
  AUTH_FIELD_KEY_PATTERN,
  AUTH_SERVICE_PATTERN,
  normalizeAuthLabel,
  validateAuthCredentialFields,
  type AuthCredentialSummary,
  type AuthCredentialValues,
} from "../domain/auth-credential";
import type { AuthCredentialSaveInput, AuthCredentialStore } from "../ports/auth-credential-store";
import {
  AuthCredentialCipher,
  authCredentialAdditionalData,
  authCredentialKeyPath,
  type EncryptedCredentialPayload,
} from "./auth-credential-cipher";

const AUTH_CREDENTIAL_DIRECTORY = "auth";

const fieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 32, pattern: AUTH_FIELD_KEY_PATTERN.source }),
    label: Type.String({ minLength: 1, maxLength: 45 }),
    env: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, pattern: AUTH_ENVIRONMENT_ALIAS_PATTERN.source }),
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

const credentialFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    service: Type.String({ minLength: 1, pattern: AUTH_SERVICE_PATTERN.source }),
    label: Type.String({ minLength: 1, maxLength: 80 }),
    fields: Type.Array(fieldSchema, { minItems: 1, maxItems: 5 }),
    updatedAt: Type.String({ minLength: 1 }),
    encryption: encryptedPayloadSchema,
  },
  { additionalProperties: false },
);

interface CredentialFile extends AuthCredentialSummary {
  readonly version: 1;
  readonly encryption: EncryptedCredentialPayload & { readonly algorithm: "aes-256-gcm" };
}

/**
 * Stores one encrypted JSON file per service under the user's credentials
 * directory. The directory and files are owner-only, and the plaintext values
 * never appear in a listing, a log, or the file itself.
 */
export class FileAuthCredentialStore implements AuthCredentialStore {
  private readonly cipher: AuthCredentialCipher;

  constructor(
    private readonly agentDir: string,
    private readonly logger?: Logger,
  ) {
    this.cipher = new AuthCredentialCipher(authCredentialKeyPath(agentDir));
  }

  async save(userId: string, input: AuthCredentialSaveInput): Promise<AuthCredentialSummary> {
    const fieldProblem = validateAuthCredentialFields(input.fields);
    if (fieldProblem) throw new Error(fieldProblem);
    if (!AUTH_SERVICE_PATTERN.test(input.service)) {
      throw new Error(`Invalid service name: ${input.service}`);
    }
    const label = normalizeAuthLabel(input.label);
    if (label.length === 0 || label.length > 80) {
      throw new Error("A credential label must be 1 to 80 characters.");
    }

    const fields = input.fields.map((field) => ({
      key: field.key,
      label: normalizeAuthLabel(field.label),
      ...(field.env ? { env: field.env } : {}),
    }));
    const expectedKeys = fields.map((field) => field.key).toSorted();
    const actualKeys = Object.keys(input.values).toSorted();
    if (
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) => key !== actualKeys[index])
    ) {
      throw new Error("Credential values do not match the declared fields.");
    }
    if (!Object.values(input.values).every((value) => typeof value === "string")) {
      throw new Error("Credential values must be strings.");
    }

    const environment = this.resolveEnvironment(userId);
    const directory = this.getDirectory(environment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);

    const file: CredentialFile = {
      version: 1,
      service: input.service,
      label,
      fields,
      updatedAt: input.updatedAt,
      encryption: {
        algorithm: "aes-256-gcm",
        ...this.cipher.encrypt(
          JSON.stringify(input.values),
          authCredentialAdditionalData(userId, input.service),
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

  async read(userId: string, service: string): Promise<AuthCredentialValues | undefined> {
    this.requireService(service);
    const path = this.getFilePath(this.getDirectory(this.resolveEnvironment(userId)), service);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }

    const file = parseCredentialFile(raw, path);
    if (file.service !== service) {
      throw new Error(`Credential file service mismatch: ${path}`);
    }

    let value: unknown;
    try {
      value = parseJson(
        this.cipher.decrypt(file.encryption, authCredentialAdditionalData(userId, service)),
      );
    } catch (error) {
      throw new Error(`Failed to decrypt credential: ${service} for ${userId}`, { cause: error });
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(
        value,
        file.fields.map((field) => field.key),
      )
    ) {
      throw new Error(`Credential values are invalid: ${path}`);
    }

    const entries: [string, string][] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        throw new TypeError(`Credential values are invalid: ${path}`);
      }
      entries.push([key, entry]);
    }

    return {
      ...toSummary(file),
      values: Object.fromEntries(entries),
    };
  }

  async list(userId: string): Promise<readonly AuthCredentialSummary[]> {
    const directory = this.getDirectory(this.resolveEnvironment(userId));
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }

    const summaries: AuthCredentialSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = resolve(directory, entry.name);
      try {
        summaries.push(toSummary(parseCredentialFile(await readFile(path, "utf8"), path)));
      } catch (error) {
        this.logger?.warn(
          { err: error, event: "auth_credential_file_invalid", userId, path },
          "Skipping an unreadable credential file",
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
    return resolve(environment.credentialsDirectory, AUTH_CREDENTIAL_DIRECTORY);
  }

  private getFilePath(directory: string, service: string): string {
    return resolve(directory, `${service}.json`);
  }

  private requireService(service: string): void {
    if (!AUTH_SERVICE_PATTERN.test(service)) {
      throw new Error(`Invalid service name: ${service}`);
    }
  }
}

function toSummary(file: CredentialFile): AuthCredentialSummary {
  return {
    service: file.service,
    label: file.label,
    fields: file.fields,
    updatedAt: file.updatedAt,
  };
}

function parseCredentialFile(raw: string, path: string): CredentialFile {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch (error) {
    throw new Error(`Credential file is not valid JSON: ${path}`, { cause: error });
  }
  if (!Check(credentialFileSchema, value)) {
    const errors = Errors(credentialFileSchema, value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || "$"}: ${error.message}`)
      .join("; ");
    throw new Error(`Credential file is invalid: ${path}. ${errors}`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}
