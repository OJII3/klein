import type { PinoLog } from "../../api";
import { JsonValue } from "../../components/json-value";
import { levelLabel } from "../../lib/format";

export function LogDetails({ log }: { log: PinoLog }) {
  const attributes = Object.keys(log.attributes ?? {}).length > 0 ? log.attributes : null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-6 text-sm">
        <span>
          ID <code className="rounded bg-base-300 px-1.5 py-0.5 font-mono text-xs">{log.id}</code>
        </span>
        <span>レベル {levelLabel(log.level)}</span>
      </div>
      {attributes ? (
        <JsonValue value={attributes} />
      ) : (
        <p className="text-sm opacity-70">属性はありません</p>
      )}
    </div>
  );
}
