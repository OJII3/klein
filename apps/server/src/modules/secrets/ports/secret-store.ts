import type { SecretField, SecretSummary, SecretValues } from "../domain/secret";

export interface SecretSaveInput {
  readonly service: string;
  readonly label: string;
  readonly fields: readonly SecretField[];
  readonly values: Readonly<Record<string, string>>;
  readonly updatedAt: string;
}

/**
 * Encrypted secret files for one linked user. Values leave the store only
 * for the sandboxed command runner; listings never decrypt them.
 */
export interface SecretStore {
  save(userId: string, input: SecretSaveInput): Promise<SecretSummary>;
  read(userId: string, service: string): Promise<SecretValues | undefined>;
  list(userId: string): Promise<readonly SecretSummary[]>;
  delete(userId: string, service: string): Promise<boolean>;
}
