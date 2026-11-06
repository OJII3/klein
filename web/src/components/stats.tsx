import type { ComponentChildren } from "preact";

export function StatStrip({ children }: { children: ComponentChildren }) {
  return (
    <div className="stats stats-horizontal border border-base-300 bg-base-100">{children}</div>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  tone?: string;
}

export function Stat({ label, value, tone = "text-ink" }: StatProps) {
  return (
    <div className="stat min-w-[5.25rem] px-3 py-2">
      <div className="stat-title text-[0.63rem] text-ink-faint">{label}</div>
      <div className={`stat-value mt-1 font-mono text-[0.88rem] font-medium ${tone}`}>{value}</div>
    </div>
  );
}
