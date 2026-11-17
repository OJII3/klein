/** Runtime type guards and safe parsing helpers. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function isFileNotFound(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}
