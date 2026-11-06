import type { PinoLog } from "../../api";
import { JsonValue } from "../../components/json-value";
import { formatTimestamp, levelLabel } from "../../lib/format";

export function LogDetails({ log }: { log: PinoLog }) {
  const attributes = Object.keys(log.attributes ?? {}).length > 0 ? log.attributes : null;

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-1 text-[0.72rem]">
        <div className="flex gap-2">
          <dt className="text-ink-faint">ID</dt>
          <dd className="font-mono text-ink-soft">{log.id}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-faint">レベル</dt>
          <dd className="font-mono text-ink-soft">{levelLabel(log.level)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-faint">イベント</dt>
          <dd className="font-mono text-ink-soft">{log.kind}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-faint">時刻</dt>
          <dd className="font-mono text-ink-soft">{formatTimestamp(log.timestamp)}</dd>
        </div>
      </dl>
      {attributes ? (
        <JsonValue value={attributes} />
      ) : (
        <p className="text-sm text-ink-faint">属性はありません</p>
      )}
    </div>
  );
}
