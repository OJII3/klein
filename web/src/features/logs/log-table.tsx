import { Fragment } from "preact";

import type { PinoLog } from "../../api";
import { dayKey, formatClockSeconds, formatDayLabel, levelLabel } from "../../lib/format";
import { LogDetails } from "./log-details";

interface LogTableProps {
  logs: PinoLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

interface LogDay {
  key: string;
  label: string;
  items: PinoLog[];
}

function groupByDay(logs: PinoLog[]): LogDay[] {
  const days: LogDay[] = [];
  for (const log of logs) {
    const key = dayKey(log.timestamp);
    const current = days.at(-1);
    if (current?.key === key) {
      current.items.push(log);
    } else {
      days.push({ key, label: formatDayLabel(log.timestamp), items: [log] });
    }
  }
  return days;
}

function levelTone(level: number | string): string {
  switch (levelLabel(level).toLowerCase()) {
    case "warn":
      return "badge-warning badge-soft";
    case "error":
    case "fatal":
      return "badge-error badge-soft";
    case "info":
      return "badge-info badge-soft";
    default:
      return "badge-ghost";
  }
}

export function LogTable({ logs, expandedId, onToggle }: LogTableProps) {
  const days = groupByDay(logs);

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr className="border-b border-line bg-surface-muted">
            <th className="w-[5.5rem] px-3 py-2 text-[0.68rem] font-medium text-ink-faint">時刻</th>
            <th className="w-[5.5rem] px-3 py-2 text-[0.68rem] font-medium text-ink-faint">
              レベル
            </th>
            <th className="hidden px-3 py-2 text-[0.68rem] font-medium text-ink-faint md:table-cell">
              イベント
            </th>
            <th className="px-3 py-2 text-[0.68rem] font-medium text-ink-faint">概要</th>
          </tr>
        </thead>
        {days.map((day) => (
          <tbody key={day.key}>
            <tr>
              <th
                className="border-y border-line bg-surface-muted px-3 py-1.5 text-left"
                colSpan={4}
                scope="rowgroup"
              >
                <span className="text-[0.72rem] font-medium text-ink-soft">{day.label}</span>
                <span className="ml-2 font-mono text-[0.62rem] text-ink-faint">
                  {day.items.length} 件
                </span>
              </th>
            </tr>
            {day.items.map((log) => {
              const isExpanded = expandedId === log.id;
              return (
                <Fragment key={log.id}>
                  <tr
                    className="cursor-pointer border-b border-line/70 align-top transition-colors hover:bg-surface-muted/70"
                    onClick={() => onToggle(log.id)}
                  >
                    <td className="px-3 py-2">
                      <button
                        aria-expanded={isExpanded}
                        aria-label={`${log.kind}: ${log.summary}`}
                        className="block w-full text-left"
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggle(log.id);
                        }}
                        type="button"
                      >
                        <time
                          className="font-mono text-[0.68rem] text-ink-soft"
                          dateTime={log.timestamp}
                        >
                          {formatClockSeconds(log.timestamp)}
                        </time>
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`badge badge-sm min-w-[3.2rem] justify-center font-mono font-medium ${levelTone(
                          log.level,
                        )}`}
                      >
                        {levelLabel(log.level)}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2 md:table-cell">
                      <code
                        className="block max-w-[16rem] truncate font-mono text-[0.68rem] text-ink-soft"
                        title={log.kind}
                      >
                        {log.kind}
                      </code>
                    </td>
                    <td className="px-3 py-2">
                      <p className="line-clamp-2 text-[0.8rem] leading-5 text-ink">{log.summary}</p>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-b border-line bg-surface-muted">
                      <td className="px-4 py-3" colSpan={4}>
                        <LogDetails log={log} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
