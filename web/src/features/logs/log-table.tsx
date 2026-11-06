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

function levelTone(level: number | string): { dot: string; text: string } {
  switch (levelLabel(level).toLowerCase()) {
    case "warn":
      return { dot: "bg-brass", text: "text-brass-soft" };
    case "error":
    case "fatal":
      return { dot: "bg-ember", text: "text-ember" };
    case "info":
      return { dot: "bg-sky", text: "text-ink-soft" };
    default:
      return { dot: "bg-ink-faint", text: "text-ink-faint" };
  }
}

export function LogTable({ logs, expandedId, onToggle }: LogTableProps) {
  const days = groupByDay(logs);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-rule-strong">
            <th className="w-[4.25rem] py-2 pr-2 font-sans text-[0.68rem] font-medium text-ink-faint sm:w-[5rem] sm:pr-3">
              時刻
            </th>
            <th className="w-[3.9rem] py-2 pr-2 font-sans text-[0.68rem] font-medium text-ink-faint sm:w-[4.5rem] sm:pr-3">
              レベル
            </th>
            <th className="hidden py-2 pr-4 font-sans text-[0.68rem] font-medium text-ink-faint md:table-cell md:w-[15rem]">
              イベント
            </th>
            <th className="py-2 font-sans text-[0.68rem] font-medium text-ink-faint">概要</th>
          </tr>
        </thead>
        {days.map((day) => (
          <tbody key={day.key}>
            <tr>
              <th
                className="border-b border-rule bg-night-900/40 px-2 py-2 text-left"
                colSpan={4}
                scope="rowgroup"
              >
                <span className="flex items-baseline gap-3">
                  <span className="font-serif text-[0.86rem] font-normal text-ink-soft">
                    {day.label}
                  </span>
                  <span className="font-mono text-[0.64rem] text-ink-faint">
                    {day.items.length} 件
                  </span>
                </span>
              </th>
            </tr>
            {day.items.map((log) => {
              const isExpanded = expandedId === log.id;
              const tone = levelTone(log.level);
              return (
                <Fragment key={log.id}>
                  <tr
                    className="cursor-pointer border-b border-rule/60 align-top transition-colors hover:bg-night-850/70"
                    onClick={() => onToggle(log.id)}
                  >
                    <td className="py-2.5 pr-2 sm:pr-3">
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
                          className="font-mono text-[0.7rem] text-ink-faint"
                          dateTime={log.timestamp}
                        >
                          {formatClockSeconds(log.timestamp)}
                        </time>
                      </button>
                    </td>
                    <td className="py-2.5 pr-2 sm:pr-3">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={`size-1.5 rounded-full ${tone.dot}`} />
                        <span className={`font-mono text-[0.66rem] ${tone.text}`}>
                          {levelLabel(log.level)}
                        </span>
                      </span>
                    </td>
                    <td className="hidden py-2.5 pr-4 md:table-cell md:w-[15rem]">
                      <code
                        className="block max-w-[15rem] truncate font-mono text-[0.68rem] text-ink-faint"
                        title={log.kind}
                      >
                        {log.kind}
                      </code>
                    </td>
                    <td className="py-2.5">
                      <p className="text-[0.83rem] leading-6 text-ink">{log.summary}</p>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-b border-rule bg-night-900/40">
                      <td className="px-3 py-4" colSpan={4}>
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
