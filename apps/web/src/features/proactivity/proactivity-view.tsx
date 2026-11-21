import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";

import {
  type FollowUpStatus,
  type FollowUpView,
  type FollowUpWatcherKind,
  type InitiativeGoalDelivery,
  type InitiativeGoalRisk,
  type InitiativeGoalStatus,
  type InitiativeGoalView,
  type ProactiveDeliveryMode,
  type ProactivePreferenceView,
  type ProactiveSignalStatus,
  type ProactiveSignalView,
  type ProactiveTopicMode,
  type ProactiveUrgency,
  type ProactivityReport,
} from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";
import { formatCompactTimestamp } from "../../lib/format";

interface ProactivityViewProps {
  report: ProactivityReport | null;
  loading: boolean;
  error: string | null;
  channelNames: ReadonlyMap<string, string>;
  onRetry: () => void;
}

type SignalFilter = "all" | ProactiveSignalStatus;

const SIGNAL_FILTERS: readonly { value: SignalFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "queued", label: "保留" },
  { value: "surfaced", label: "提示済み" },
  { value: "dismissed", label: "却下" },
  { value: "expired", label: "期限切れ" },
];

const SIGNAL_STATUS_LABELS: Readonly<Record<ProactiveSignalStatus, string>> = {
  queued: "保留",
  surfaced: "提示済み",
  dismissed: "却下",
  expired: "期限切れ",
};

const SIGNAL_STATUS_TONES: Readonly<Record<ProactiveSignalStatus, string>> = {
  queued: "badge-success badge-soft",
  surfaced: "badge-info badge-soft",
  dismissed: "badge-ghost",
  expired: "badge-ghost",
};

const URGENCY_LABELS: Readonly<Record<ProactiveUrgency, string>> = {
  now: "今すぐ",
  today: "今日中",
  digest: "まとめ",
  silent: "静か",
};

const URGENCY_TONES: Readonly<Record<ProactiveUrgency, string>> = {
  now: "badge-error badge-soft",
  today: "badge-warning badge-soft",
  digest: "badge-info badge-soft",
  silent: "badge-ghost",
};

const DELIVERY_LABELS: Readonly<Record<ProactiveDeliveryMode, string>> = {
  interrupt: "すぐ話す",
  attach: "次の発言に添える",
  digest: "まとめて話す",
  silent: "保存のみ",
};

const FOLLOW_UP_STATUS_LABELS: Readonly<Record<FollowUpStatus, string>> = {
  active: "追跡中",
  notified: "通知済み",
  done: "完了",
  orphaned: "監視なし",
  expired: "期限切れ",
  dismissed: "取り下げ",
};

const FOLLOW_UP_STATUS_TONES: Readonly<Record<FollowUpStatus, string>> = {
  active: "badge-success badge-soft",
  notified: "badge-info badge-soft",
  done: "badge-ghost",
  orphaned: "badge-warning badge-soft",
  expired: "badge-ghost",
  dismissed: "badge-ghost",
};

const WATCHER_LABELS: Readonly<Record<FollowUpWatcherKind, string>> = {
  watch: "監視",
  reminder: "リマインダー",
  worker: "ワーカー",
};

const GOAL_STATUS_LABELS: Readonly<Record<InitiativeGoalStatus, string>> = {
  scheduled: "実行待ち",
  running: "実行中",
  ready: "結果あり",
  delivered: "配信済み",
  dismissed: "取り下げ",
  expired: "期限切れ",
  failed: "失敗",
};

const GOAL_STATUS_TONES: Readonly<Record<InitiativeGoalStatus, string>> = {
  scheduled: "badge-info badge-soft",
  running: "badge-warning badge-soft",
  ready: "badge-success badge-soft",
  delivered: "badge-ghost",
  dismissed: "badge-ghost",
  expired: "badge-ghost",
  failed: "badge-error badge-soft",
};

const GOAL_RISK_LABELS: Readonly<Record<InitiativeGoalRisk, string>> = {
  low: "低リスク",
  medium: "中リスク",
  high: "高リスク",
};

const GOAL_DELIVERY_LABELS: Readonly<Record<InitiativeGoalDelivery, string>> = {
  interrupt: "すぐ話す",
  attach: "次の発言に添える",
  digest: "まとめて話す",
  silent: "保存のみ",
};

const TOPIC_MODE_LABELS: Readonly<Record<ProactiveTopicMode, string>> = {
  allow: "許可",
  mute: "禁止",
  "urgent-only": "緊急のみ",
};

export function ProactivityView({
  report,
  loading,
  error,
  channelNames,
  onRetry,
}: ProactivityViewProps) {
  const queuedSignals = report?.signals.filter((signal) => signal.status === "queued") ?? [];
  const surfacedSignals = report?.signals.filter((signal) => signal.status === "surfaced") ?? [];
  const activeFollowUps =
    report?.followUps.filter((followUp) => followUp.status === "active") ?? [];
  const activeGoals =
    report?.goals.filter(
      (goal) => goal.status === "scheduled" || goal.status === "running" || goal.status === "ready",
    ) ?? [];

  return (
    <section className="flex flex-col gap-4" aria-labelledby="proactivity-heading">
      <ViewHeader headingId="proactivity-heading" title="自発">
        {report && (
          <StatStrip>
            <Stat label="保留中の候補" value={queuedSignals.length.toLocaleString("ja-JP")} />
            <Stat label="提示済み" value={surfacedSignals.length.toLocaleString("ja-JP")} />
            <Stat label="追跡中の約束" value={activeFollowUps.length.toLocaleString("ja-JP")} />
            <Stat label="Goal" value={activeGoals.length.toLocaleString("ja-JP")} />
            <Stat label="好み" value={report.preferences.length.toLocaleString("ja-JP")} />
          </StatStrip>
        )}
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {!error && loading && !report ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : !error && !report ? null : report && !report.enabled ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>自発的な活動は無効です</EmptyState>
        </div>
      ) : report ? (
        <>
          <SignalSection
            channelNames={channelNames}
            signals={report.signals}
            truncated={report.signalsTruncated}
          />
          <GoalSection channelNames={channelNames} goals={report.goals} />
          <FollowUpSection channelNames={channelNames} followUps={report.followUps} />
          <PreferenceSection channelNames={channelNames} preferences={report.preferences} />
        </>
      ) : null}
    </section>
  );
}

function SignalSection({
  channelNames,
  signals,
  truncated,
}: {
  channelNames: ReadonlyMap<string, string>;
  signals: readonly ProactiveSignalView[];
  truncated: boolean;
}) {
  const [filter, setFilter] = useState<SignalFilter>("all");
  const counts = useMemo(() => countSignalStatuses(signals), [signals]);
  const visible = useMemo(
    () => (filter === "all" ? signals : signals.filter((signal) => signal.status === filter)),
    [filter, signals],
  );

  return (
    <section className="card overflow-hidden border border-base-300 bg-base-100">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-ink">候補</h2>
          <span className="font-mono text-[0.68rem] text-ink-faint">
            {signals.length.toLocaleString("ja-JP")} 件{truncated ? "（最新のみ）" : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {SIGNAL_FILTERS.map((item) => {
            const count = item.value === "all" ? signals.length : counts[item.value];
            return (
              <button
                aria-pressed={filter === item.value}
                className={`btn btn-xs ${filter === item.value ? "btn-primary" : "btn-ghost"}`}
                key={item.value}
                onClick={() => setFilter(item.value)}
                type="button"
              >
                {item.label}
                <span className="font-mono text-[0.65rem] opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState>該当する候補がありません</EmptyState>
      ) : (
        <ul>
          {visible.map((signal) => (
            <SignalRow channelNames={channelNames} key={signal.id} signal={signal} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SignalRow({
  channelNames,
  signal,
}: {
  channelNames: ReadonlyMap<string, string>;
  signal: ProactiveSignalView;
}) {
  const evidenceUrl = signal.evidence?.url;
  const externalEvidenceUrl = evidenceUrl === undefined ? undefined : toExternalUrl(evidenceUrl);

  return (
    <li className="border-b border-line/70 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`badge badge-sm ${SIGNAL_STATUS_TONES[signal.status]}`}>
              {SIGNAL_STATUS_LABELS[signal.status]}
            </span>
            <span className={`badge badge-sm ${URGENCY_TONES[signal.urgency]}`}>
              {URGENCY_LABELS[signal.urgency]}
            </span>
            {signal.deliveryMode && (
              <span className="badge badge-sm badge-ghost">
                {DELIVERY_LABELS[signal.deliveryMode]}
              </span>
            )}
            <span className="text-[0.7rem] text-ink-faint">
              {channelLabel(channelNames, signal.channelId)} · {scopeLabel(signal.accessScope)}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-snug text-ink">{signal.summary}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-ink-soft">
            <span>{signal.topic}</span>
            <span className="text-ink-faint">
              由来: {signal.source.kind}
              {signal.source.ref ? ` (${signal.source.ref})` : ""}
            </span>
            {signal.audience === "public" && (
              <span className="badge badge-xs badge-ghost">公開</span>
            )}
          </p>
          {signal.evidence && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[0.7rem] text-ink-soft">根拠</summary>
              {signal.evidence.text && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 font-mono text-[0.68rem] text-ink-soft">
                  {signal.evidence.text}
                </pre>
              )}
              {evidenceUrl && externalEvidenceUrl && (
                <a
                  className="mt-1 inline-block break-all text-[0.7rem] text-blue hover:underline"
                  href={externalEvidenceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {evidenceUrl}
                </a>
              )}
              {evidenceUrl && !externalEvidenceUrl && (
                <p className="mt-1 break-all font-mono text-[0.7rem] text-ink-faint">
                  {evidenceUrl}
                </p>
              )}
            </details>
          )}
        </div>
        <div className="shrink-0 text-right text-[0.68rem] text-ink-faint">
          <time dateTime={signal.observedAt}>{formatCompactTimestamp(signal.observedAt)}</time>
          {signal.surfacedAt && (
            <p className="mt-0.5">提示 {formatCompactTimestamp(signal.surfacedAt)}</p>
          )}
          {signal.expiresAt && (
            <p className="mt-0.5">期限 {formatCompactTimestamp(signal.expiresAt)}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function GoalSection({
  channelNames,
  goals,
}: {
  channelNames: ReadonlyMap<string, string>;
  goals: readonly InitiativeGoalView[];
}) {
  return (
    <section className="card overflow-hidden border border-base-300 bg-base-100">
      <div className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Goal</h2>
        <span className="font-mono text-[0.68rem] text-ink-faint">
          {goals.length.toLocaleString("ja-JP")} 件
        </span>
      </div>

      {goals.length === 0 ? (
        <EmptyState>自分で立てた Goal はありません</EmptyState>
      ) : (
        <ul>
          {goals.map((goal) => (
            <GoalRow channelNames={channelNames} goal={goal} key={goal.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GoalRow({
  channelNames,
  goal,
}: {
  channelNames: ReadonlyMap<string, string>;
  goal: InitiativeGoalView;
}) {
  return (
    <li className="border-b border-line/70 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`badge badge-sm ${GOAL_STATUS_TONES[goal.status]}`}>
              {GOAL_STATUS_LABELS[goal.status]}
            </span>
            <span className="badge badge-sm badge-ghost">{GOAL_RISK_LABELS[goal.risk]}</span>
            {goal.deliveryMode && (
              <span className="badge badge-sm badge-ghost">
                {GOAL_DELIVERY_LABELS[goal.deliveryMode]}
              </span>
            )}
            <span className="text-[0.7rem] text-ink-faint">
              {channelLabel(channelNames, goal.channelId)} · {scopeLabel(goal.accessScope)}
            </span>
            <span className="text-[0.7rem] text-ink-faint">
              {goal.createdBy === "planner" ? "Planner" : "会話"}
            </span>
          </div>
          <p className="mt-1.5 text-sm font-medium leading-snug text-ink">{goal.title}</p>
          <p className="mt-1 text-[0.78rem] leading-snug text-ink-soft">{goal.rationale}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-[0.7rem] text-ink-soft">実行計画</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 font-mono text-[0.68rem] text-ink-soft">
              {goal.plan}
            </pre>
          </details>
          {goal.lastError && (
            <p className="mt-1 text-[0.7rem] text-error">失敗: {goal.lastError}</p>
          )}
        </div>
        <div className="shrink-0 text-right text-[0.68rem] text-ink-faint">
          <p>実行 {formatCompactTimestamp(goal.dueAt)}</p>
          <p className="mt-0.5">期限 {formatCompactTimestamp(goal.expiresAt)}</p>
          {goal.workerId && <p className="mt-0.5 font-mono">{goal.workerId}</p>}
          {goal.signalId && <p className="mt-0.5 font-mono">{goal.signalId}</p>}
        </div>
      </div>
    </li>
  );
}

function FollowUpSection({
  channelNames,
  followUps,
}: {
  channelNames: ReadonlyMap<string, string>;
  followUps: readonly FollowUpView[];
}) {
  return (
    <section className="card overflow-hidden border border-base-300 bg-base-100">
      <div className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">約束</h2>
        <span className="font-mono text-[0.68rem] text-ink-faint">
          {followUps.length.toLocaleString("ja-JP")} 件
        </span>
      </div>

      {followUps.length === 0 ? (
        <EmptyState>追跡している約束はありません</EmptyState>
      ) : (
        <ul>
          {followUps.map((followUp) => (
            <FollowUpRow channelNames={channelNames} followUp={followUp} key={followUp.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FollowUpRow({
  channelNames,
  followUp,
}: {
  channelNames: ReadonlyMap<string, string>;
  followUp: FollowUpView;
}) {
  return (
    <li className="border-b border-line/70 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`badge badge-sm ${FOLLOW_UP_STATUS_TONES[followUp.status]}`}>
              {FOLLOW_UP_STATUS_LABELS[followUp.status]}
            </span>
            <span className="badge badge-sm badge-ghost">
              {WATCHER_LABELS[followUp.watcher.kind]}
            </span>
            <span className="text-[0.7rem] text-ink-faint">
              {channelLabel(channelNames, followUp.channelId)} · {scopeLabel(followUp.accessScope)}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-snug text-ink">{followUp.subject}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-ink-soft">
            <span>{followUp.cadenceLabel}</span>
            <span className="font-mono text-ink-faint">{followUp.watcher.id}</span>
          </p>
        </div>
        <div className="shrink-0 text-right text-[0.68rem] text-ink-faint">
          <time dateTime={followUp.createdAt}>{formatCompactTimestamp(followUp.createdAt)}</time>
          {followUp.lastNotifiedAt && (
            <p className="mt-0.5">通知 {formatCompactTimestamp(followUp.lastNotifiedAt)}</p>
          )}
          {followUp.expiresAt && (
            <p className="mt-0.5">期限 {formatCompactTimestamp(followUp.expiresAt)}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function PreferenceSection({
  channelNames,
  preferences,
}: {
  channelNames: ReadonlyMap<string, string>;
  preferences: readonly ProactivePreferenceView[];
}) {
  return (
    <section className="card overflow-hidden border border-base-300 bg-base-100">
      <div className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">好み</h2>
        <span className="font-mono text-[0.68rem] text-ink-faint">
          {preferences.length.toLocaleString("ja-JP")} 件
        </span>
      </div>

      {preferences.length === 0 ? (
        <EmptyState>保存された好みはありません</EmptyState>
      ) : (
        <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {preferences.map((preference) => (
            <PreferenceCard
              channelNames={channelNames}
              key={preference.key}
              preference={preference}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PreferenceCard({
  channelNames,
  preference,
}: {
  channelNames: ReadonlyMap<string, string>;
  preference: ProactivePreferenceView;
}) {
  const hasDelivery = Object.keys(preference.delivery).length > 0;
  const hasContent = hasDelivery || preference.topics.length > 0 || preference.notes.length > 0;

  return (
    <article className="rounded border border-line bg-surface-muted/60 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="badge badge-sm badge-ghost">
            {preference.scope === "user" ? "ユーザー" : "チャンネル"}
          </span>
          <span className="truncate text-[0.78rem] font-medium text-ink">
            {preference.scope === "channel" && preference.channelId
              ? channelLabel(channelNames, preference.channelId)
              : `ユーザー ${preference.userId ?? ""}`}
          </span>
        </div>
        <code className="font-mono text-[0.62rem] text-ink-faint">{preference.key}</code>
      </header>

      {!hasContent ? (
        <p className="mt-2 text-[0.7rem] text-ink-faint">既定のみ</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {hasDelivery && (
            <PreferenceGroup title="届け方">
              {preference.delivery.defaultMode && (
                <PreferenceLine
                  label="既定"
                  value={DELIVERY_LABELS[preference.delivery.defaultMode]}
                />
              )}
              {preference.delivery.quietHours && (
                <PreferenceLine
                  label="静かな時間"
                  value={`${preference.delivery.quietHours.start}-${preference.delivery.quietHours.end}`}
                />
              )}
              {preference.delivery.digestAt && (
                <PreferenceLine label="まとめ" value={preference.delivery.digestAt} />
              )}
              {preference.delivery.maxPerDay !== undefined && (
                <PreferenceLine label="1日の上限" value={`${preference.delivery.maxPerDay} 件`} />
              )}
            </PreferenceGroup>
          )}

          {preference.topics.length > 0 && (
            <PreferenceGroup title="話題">
              {preference.topics.map((topic) => (
                <div className="flex flex-wrap items-baseline gap-1.5" key={topic.topic}>
                  <span className="text-[0.72rem] text-ink">{topic.topic}</span>
                  <span className="badge badge-xs badge-ghost">
                    {TOPIC_MODE_LABELS[topic.mode]}
                  </span>
                  {topic.until && (
                    <span className="text-[0.65rem] text-ink-faint">{topic.until} まで</span>
                  )}
                </div>
              ))}
            </PreferenceGroup>
          )}

          {preference.notes.length > 0 && (
            <PreferenceGroup title="メモ">
              {preference.notes.map((note) => (
                <p className="text-[0.72rem] leading-snug text-ink-soft" key={note}>
                  {note}
                </p>
              ))}
            </PreferenceGroup>
          )}
        </div>
      )}
    </article>
  );
}

function PreferenceGroup({ children, title }: { children: ComponentChildren; title: string }) {
  return (
    <div>
      <h3 className="text-[0.63rem] font-medium tracking-wide text-ink-faint">{title}</h3>
      <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function PreferenceLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[0.72rem]">
      <span className="text-ink-soft">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

function countSignalStatuses(
  signals: readonly ProactiveSignalView[],
): Record<ProactiveSignalStatus, number> {
  const counts: Record<ProactiveSignalStatus, number> = {
    queued: 0,
    surfaced: 0,
    dismissed: 0,
    expired: 0,
  };
  for (const signal of signals) counts[signal.status] += 1;
  return counts;
}

function channelLabel(channelNames: ReadonlyMap<string, string>, channelId: string): string {
  const name = channelNames.get(channelId);
  return name ? `#${name}` : channelId;
}

function toExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function scopeLabel(scope: string): string {
  if (scope === "public") return "公開";
  if (scope.startsWith("owner:")) return "所有者";
  if (scope.startsWith("user:")) return `ユーザー ${scope.slice("user:".length)}`;
  return scope;
}
