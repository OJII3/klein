export type ImageAnalysisFailureReason =
  "rate_limited" | "http_error" | "empty_result" | "unavailable" | "unknown";

export interface ImageAnalysisFailure {
  readonly reason: ImageAnalysisFailureReason;
  /** HTTP status reported by the provider, when the error carries one. */
  readonly status?: number;
  /** Whether asking the user to send the image again could succeed. */
  readonly retryable: boolean;
}

export class ImageAnalysisError extends Error {
  constructor(
    readonly failure: ImageAnalysisFailure,
    message?: string,
  ) {
    super(message ?? summarizeFailure(failure));
    this.name = "ImageAnalysisError";
  }
}

export function classifyImageAnalysisFailure(message: string): ImageAnalysisFailure {
  const status = extractHttpStatus(message);
  if (status === 429) {
    return { reason: "rate_limited", status, retryable: true };
  }
  if (status !== undefined) {
    return { reason: "http_error", status, retryable: status === 408 || status >= 500 };
  }
  return { reason: "unknown", retryable: true };
}

export function toImageAnalysisFailure(error: unknown): ImageAnalysisFailure {
  if (error instanceof ImageAnalysisError) return error.failure;
  return classifyImageAnalysisFailure(error instanceof Error ? error.message : String(error));
}

function summarizeFailure(failure: ImageAnalysisFailure): string {
  const status = failure.status === undefined ? "" : ` (${failure.status})`;
  return `Image analysis failed: ${failure.reason}${status}`;
}

const STATUS_PATTERNS: readonly RegExp[] = [
  /^\s*(\d{3})\b/u,
  /\b(\d{3}):\s/u,
  /\((\d{3})\)/u,
  /\bHTTP\s+(\d{3})\b/iu,
  /["']?(?:status|statusCode|code)["']?\s*[:=]\s*(\d{3})\b/iu,
];

function extractHttpStatus(message: string): number | undefined {
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const status = findHttpStatus(JSON.parse(message.slice(jsonStart)));
      if (status !== undefined) return status;
    } catch {
      // Not JSON; fall through to the textual patterns.
    }
  }

  for (const pattern of STATUS_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const status = Number(match[1]);
    if (status >= 400 && status <= 599) return status;
  }

  return undefined;
}

function findHttpStatus(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = findHttpStatus(item);
      if (status !== undefined) return status;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && candidate >= 400 && candidate <= 599) return candidate;
  }
  for (const candidate of Object.values(record)) {
    const status = findHttpStatus(candidate);
    if (status !== undefined) return status;
  }
  return undefined;
}
