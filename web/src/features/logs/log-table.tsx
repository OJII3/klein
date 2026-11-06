import { Fragment } from "preact";

import type { PinoLog } from "../../api";
import { formatTimestamp, levelLabel } from "../../lib/format";
import { LogDetails } from "./log-details";

interface LogTableProps {
  logs: PinoLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

function levelBadgeClass(level: number | string): string {
  switch (levelLabel(level).toLowerCase()) {
    case "trace":
    case "debug":
      return "badge-ghost";
    case "info":
      return "badge-info";
    case "warn":
      return "badge-warning";
    case "error":
    case "fatal":
      return "badge-error";
    default:
      return "badge-ghost";
  }
}

export function LogTable({ logs, expandedId, onToggle }: LogTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>時刻</th>
            <th>レベル</th>
            <th>イベント</th>
            <th>概要</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const isExpanded = expandedId === log.id;
            return (
              <Fragment key={log.id}>
                <tr
                  aria-expanded={isExpanded}
                  aria-label={`${log.kind}: ${log.summary}`}
                  className="cursor-pointer hover:bg-base-300/40"
                  onClick={() => onToggle(log.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onToggle(log.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <td>
                    <time className="text-sm" dateTime={log.timestamp}>
                      {formatTimestamp(log.timestamp)}
                    </time>
                  </td>
                  <td>
                    <span className={`badge badge-sm ${levelBadgeClass(log.level)}`}>
                      {levelLabel(log.level)}
                    </span>
                  </td>
                  <td>
                    <code className="rounded bg-base-300 px-1.5 py-0.5 font-mono text-xs">
                      {log.kind}
                    </code>
                  </td>
                  <td>
                    <p className="line-clamp-2 text-sm">{log.summary}</p>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={4}>
                      <LogDetails log={log} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
