/** A service slug is also the file name and the environment-variable prefix. */
export const AUTH_SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

/** Field keys become the last segment of `KLEIN_AUTH_<SERVICE>_<FIELD>`. */
export const AUTH_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;

/** Discord modals accept at most five text inputs. */
export const AUTH_MAX_FIELDS = 5;

export const AUTH_DEFAULT_REQUEST_TTL_MINUTES = 15;
export const AUTH_MAX_REQUEST_TTL_MINUTES = 60;

export interface AuthCredentialField {
  readonly key: string;
  readonly label: string;
}

/** Metadata that can be shown without decrypting any value. */
export interface AuthCredentialSummary {
  readonly service: string;
  readonly label: string;
  readonly fields: readonly AuthCredentialField[];
  readonly updatedAt: string;
}

/** Decrypted credential values, only used to build a sandbox environment. */
export interface AuthCredentialValues extends AuthCredentialSummary {
  readonly values: Readonly<Record<string, string>>;
}

export function authEnvironmentVariableName(service: string, fieldKey: string): string {
  return `KLEIN_AUTH_${service.toUpperCase().replaceAll("-", "_")}_${fieldKey.toUpperCase()}`;
}

/** Discord modal titles and input labels are single-line. */
export function normalizeAuthLabel(label: string): string {
  return label.replaceAll(/\s+/gu, " ").trim();
}

/** Returns the first validation problem, or undefined when the fields are usable. */
export function validateAuthCredentialFields(
  fields: readonly AuthCredentialField[],
): string | undefined {
  if (fields.length === 0) return "At least one field is required.";
  if (fields.length > AUTH_MAX_FIELDS) {
    return `At most ${AUTH_MAX_FIELDS} fields are supported.`;
  }

  const keys = new Set<string>();
  const environmentNames = new Set<string>();
  for (const field of fields) {
    if (!AUTH_FIELD_KEY_PATTERN.test(field.key)) {
      return `Invalid field key: ${field.key}`;
    }
    if (keys.has(field.key)) return `Duplicate field key: ${field.key}`;
    keys.add(field.key);

    const label = normalizeAuthLabel(field.label);
    if (label.length === 0 || label.length > 45) {
      return `Field labels must be 1 to 45 characters: ${field.key}`;
    }

    const environmentName = authEnvironmentVariableName("service", field.key);
    if (environmentNames.has(environmentName)) {
      return `Field keys collide as environment variables: ${field.key}`;
    }
    environmentNames.add(environmentName);
  }
  return undefined;
}
