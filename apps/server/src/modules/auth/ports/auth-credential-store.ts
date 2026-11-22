import type {
  AuthCredentialField,
  AuthCredentialSummary,
  AuthCredentialValues,
} from "../domain/auth-credential";

export interface AuthCredentialSaveInput {
  readonly service: string;
  readonly label: string;
  readonly fields: readonly AuthCredentialField[];
  readonly values: Readonly<Record<string, string>>;
  readonly updatedAt: string;
}

/**
 * Encrypted credential files for one linked user. Values leave the store only
 * for the sandboxed command runner; listings never decrypt them.
 */
export interface AuthCredentialStore {
  save(userId: string, input: AuthCredentialSaveInput): Promise<AuthCredentialSummary>;
  read(userId: string, service: string): Promise<AuthCredentialValues | undefined>;
  list(userId: string): Promise<readonly AuthCredentialSummary[]>;
  delete(userId: string, service: string): Promise<boolean>;
}
