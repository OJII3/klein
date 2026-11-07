import type { McpServerUsageStat, ToolUsageReport, ToolUsageStat } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp } from "../../lib/format";

interface ToolsViewProps {
  report: ToolUsageReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

export function ToolsView({ report, loading, error, onRetry }: ToolsViewProps) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="tools-heading">
      <ViewHeader headingId="tools-heading" title="ツール使用状況">
        {report && (
          <StatStrip>
            <Stat label="呼び出し" value={report.totalCalls.toLocaleString("ja-JP")} />
            <Stat label="ツール" value={report.tools.length.toLocaleString("ja-JP")} />
            <Stat label="MCP サーバー" value={report.mcpServers.length.toLocaleString("ja-JP")} />
            <Stat
              label="エラー"
              tone={report.totalErrors > 0 ? "text-red" : "text-ink"}
              value={report.totalErrors.toLocaleString("ja-JP")}
            />
          </StatStrip>
        )}
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {loading && !report ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : !report ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>ツールの呼び出し履歴がまだありません</EmptyState>
        </div>
      ) : report.tools.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>ツールの呼び出し履歴がまだありません</EmptyState>
        </div>
      ) : (
        <>
          {report.mcpServers.length > 0 && <McpServerTable servers={report.mcpServers} />}
          <ToolTable report={report} />
        </>
      )}
    </section>
  );
}

function McpServerTable({ servers }: { servers: McpServerUsageStat[] }) {
  return (
    <div className="card overflow-hidden border border-base-300 bg-base-100">
      <SectionHeader count={`${servers.length} 台`} title="MCP サーバー" />
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th className="px-3 py-2 text-[0.68rem] font-medium text-ink-faint">サーバー</th>
              <th className="w-[6rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint">
                呼び出し
              </th>
              <th className="w-[5rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint">
                ツール
              </th>
              <th className="w-[5rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint">
                エラー
              </th>
              <th className="hidden w-[9rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint sm:table-cell">
                最終呼び出し
              </th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr className="border-b border-line/70 last:border-b-0" key={server.name}>
                <td className="px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="badge badge-sm badge-info badge-soft">MCP</span>
                    <code className="truncate font-mono text-[0.78rem] text-ink">
                      {server.name}
                    </code>
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-[0.78rem] text-ink">
                  {server.calls.toLocaleString("ja-JP")}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[0.78rem] text-ink-soft">
                  {server.toolCount.toLocaleString("ja-JP")}
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono text-[0.78rem] ${tone(server.errors)}`}
                >
                  {server.errors.toLocaleString("ja-JP")}
                </td>
                <td className="hidden px-3 py-2 text-right font-mono text-[0.68rem] text-ink-faint sm:table-cell">
                  {formatCompactTimestamp(server.lastCalledAt ?? undefined)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ToolTable({ report }: { report: ToolUsageReport }) {
  return (
    <div className="card overflow-hidden border border-base-300 bg-base-100">
      <SectionHeader count={`${report.tools.length} 種`} title="ツール" />
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr className="border-b border-line bg-surface-muted">
              <th className="px-3 py-2 text-[0.68rem] font-medium text-ink-faint">ツール</th>
              <th className="hidden w-[10rem] px-3 py-2 text-[0.68rem] font-medium text-ink-faint md:table-cell">
                種別
              </th>
              <th className="w-[6rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint">
                呼び出し
              </th>
              <th className="w-[5rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint">
                エラー
              </th>
              <th className="hidden w-[9rem] px-3 py-2 text-right text-[0.68rem] font-medium text-ink-faint sm:table-cell">
                最終呼び出し
              </th>
            </tr>
          </thead>
          <tbody>
            {report.tools.map((tool) => (
              <tr className="border-b border-line/70 last:border-b-0" key={tool.name}>
                <td className="px-3 py-2">
                  <code className="block max-w-[34rem] truncate font-mono text-[0.78rem] text-ink">
                    {tool.name}
                  </code>
                  <span className="mt-0.5 block text-[0.62rem] text-ink-faint md:hidden">
                    {toolKind(tool)}
                  </span>
                </td>
                <td className="hidden px-3 py-2 md:table-cell">{kindBadge(tool)}</td>
                <td className="px-3 py-2 text-right font-mono text-[0.78rem] text-ink">
                  {tool.calls.toLocaleString("ja-JP")}
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono text-[0.78rem] ${tone(tool.errors)}`}
                >
                  {tool.errors.toLocaleString("ja-JP")}
                </td>
                <td className="hidden px-3 py-2 text-right font-mono text-[0.68rem] text-ink-faint sm:table-cell">
                  {formatCompactTimestamp(tool.lastCalledAt ?? undefined)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-3 py-2">
      <h2 className="text-[0.8rem] font-medium text-ink">{title}</h2>
      <span className="font-mono text-[0.62rem] text-ink-faint">{count}</span>
    </div>
  );
}

function mcpServerName(toolName: string): string | undefined {
  return MCP_TOOL_NAME.exec(toolName)?.[1];
}

function toolKind(tool: ToolUsageStat): string {
  const server = mcpServerName(tool.name);
  return server ? `MCP: ${server}` : "組み込み";
}

function kindBadge(tool: ToolUsageStat) {
  const server = mcpServerName(tool.name);
  return server ? (
    <span className="badge badge-sm badge-info badge-soft normal-case">MCP: {server}</span>
  ) : (
    <span className="badge badge-sm badge-ghost">組み込み</span>
  );
}

function tone(errors: number): string {
  return errors > 0 ? "text-red" : "text-ink-soft";
}
