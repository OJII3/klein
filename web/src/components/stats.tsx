import type { ComponentChildren } from "preact";

export function StatStrip({ children }: { children: ComponentChildren }) {
  return (
    <div className="flex divide-x divide-line overflow-hidden rounded-md border border-line bg-surface">
      {children}
    </div>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  tone?: string;
}

export function Stat({ label, value, tone = "text-ink" }: StatProps) {
  return (
    <div className="min-w-[5.25rem] px-3 py-2">
      <p className="text-[0.63rem] leading-none text-ink-faint">{label}</p>
      <p className={`mt-1 font-mono text-[0.88rem] leading-none font-medium ${tone}`}>{value}</p>
    </div>
  );
}
