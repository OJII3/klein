import { isJsonContainer, stringify } from "../lib/format";

interface JsonValueProps {
  value: unknown;
}

export function JsonValue({ value }: JsonValueProps) {
  const text = isJsonContainer(value)
    ? (JSON.stringify(value, null, 2) ?? stringify(value))
    : stringify(value);

  return (
    <pre
      aria-label="JSON データ"
      className="max-h-96 overflow-auto rounded-sm border border-rule bg-night-900/70 p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap text-ink-soft"
    >
      {text}
    </pre>
  );
}
