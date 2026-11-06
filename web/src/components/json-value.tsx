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
      className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-box border border-base-300 bg-base-300/40 p-3 font-mono text-xs"
    >
      {text}
    </pre>
  );
}
