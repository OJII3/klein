export const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function formatShortTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const visibleLength = maxLength - 1;
  const startLength = Math.ceil(visibleLength / 2);
  const endLength = Math.floor(visibleLength / 2);
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

export function levelLabel(level: number | string): string {
  if (typeof level === "number") return LEVEL_LABELS[level] ?? String(level);
  return level;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}
