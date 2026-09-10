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

export function levelLabel(level: number | string): string {
  if (typeof level === "number") return LEVEL_LABELS[level] ?? String(level);
  return level;
}

export function levelClass(level: number | string): string {
  const label = levelLabel(level);
  return `level-${label.toLowerCase()}`;
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
