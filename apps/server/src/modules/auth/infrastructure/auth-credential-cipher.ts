import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

/** The key stays outside every user environment, next to the agent directory. */
export const AUTH_CREDENTIAL_KEY_FILE = "credential-key";

export interface EncryptedCredentialPayload {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export function authCredentialKeyPath(agentDir: string): string {
  return resolve(agentDir, AUTH_CREDENTIAL_KEY_FILE);
}

/**
 * Encrypts credential values with AES-256-GCM. The key file is created on
 * first use with owner-only permissions. Losing the key makes existing
 * credentials unreadable; they must be requested again.
 */
export class AuthCredentialCipher {
  private key?: Buffer;

  constructor(private readonly keyPath: string) {}

  encrypt(plaintext: string, additionalData: string): EncryptedCredentialPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.loadKey(), iv);
    cipher.setAAD(Buffer.from(additionalData, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  decrypt(payload: EncryptedCredentialPayload, additionalData: string): string {
    if (!this.key && !existsSync(this.keyPath)) {
      throw new Error(`Credential key is missing: ${this.keyPath}`);
    }
    const decipher = createDecipheriv(ALGORITHM, this.loadKey(), Buffer.from(payload.iv, "base64"));
    decipher.setAAD(Buffer.from(additionalData, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private loadKey(): Buffer {
    if (this.key) return this.key;

    mkdirSync(dirname(this.keyPath), { recursive: true, mode: 0o700 });
    try {
      const stats = lstatSync(this.keyPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Credential key is not a regular file: ${this.keyPath}`);
      }
      const key = readFileSync(this.keyPath);
      if (key.byteLength !== KEY_BYTES) {
        throw new Error(`Credential key must be ${KEY_BYTES} bytes: ${this.keyPath}`);
      }
      if (process.platform !== "win32") chmodSync(this.keyPath, 0o600);
      this.key = key;
      return key;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    const key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(this.keyPath, key, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // Another request created the key first; read that key instead.
      return this.loadKey();
    }
    if (process.platform !== "win32") chmodSync(this.keyPath, 0o600);
    this.key = key;
    return key;
  }
}

export function authCredentialAdditionalData(userId: string, service: string): string {
  return `${userId}\u0000${service}\u0000${ALGORITHM}`;
}

function isFileNotFound(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
