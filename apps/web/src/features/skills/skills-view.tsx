import { useCallback, useLayoutEffect, useState } from "preact/hooks";

import type { SkillDiagnostic, SkillFileContent, SkillSummary, SkillsReport } from "../../api";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/feedback";
import { Stat, StatStrip } from "../../components/stats";
import { ViewHeader } from "../../components/view-header";

interface SkillsViewProps {
  report: SkillsReport | null;
  loading: boolean;
  error: string | null;
  selectedSkillName: string | null;
  selectedSkill: SkillSummary | null;
  selectedPath: string;
  fileContent: SkillFileContent | null;
  fileLoading: boolean;
  fileError: string | null;
  onSelectSkill: (name: string) => void;
  onBack: () => void;
  onSelectFile: (path: string) => void;
  onRetry: () => void;
  onRetryFile: () => void;
}

type AvailabilityKey = keyof SkillSummary["availability"];

const AUDIENCES: readonly { key: AvailabilityKey; label: string }[] = [
  { key: "conversation", label: "Conversation" },
  { key: "ownerWorker", label: "Owner worker" },
  { key: "linkedUserWorker", label: "Linked-user worker" },
];

type SkillGroupKey = "both" | "worker" | "conversation" | "unavailable";

const GROUPS: readonly { key: SkillGroupKey; title: string }[] = [
  { key: "both", title: "Both agents" },
  { key: "worker", title: "Worker only" },
  { key: "conversation", title: "Conversation only" },
  { key: "unavailable", title: "Unavailable" },
];

export function SkillsView(props: SkillsViewProps) {
  const {
    report,
    loading,
    error,
    selectedSkillName,
    selectedSkill,
    selectedPath,
    fileContent,
    fileLoading,
    fileError,
    onSelectSkill,
    onBack,
    onSelectFile,
    onRetry,
    onRetryFile,
  } = props;
  const [scrollPosition, setScrollPosition] = useState(0);
  const [detailWasOpen, setDetailWasOpen] = useState(false);
  const totalFiles = report?.skills.reduce((sum, skill) => sum + skill.files.length, 0) ?? 0;

  const openSkill = useCallback(
    (name: string) => {
      setScrollPosition(window.scrollY);
      setDetailWasOpen(true);
      onSelectSkill(name);
      if (!isDesktop()) {
        window.scrollTo({ top: 0 });
      }
    },
    [onSelectSkill],
  );

  useLayoutEffect(() => {
    if (detailWasOpen && !selectedSkillName && !isDesktop()) {
      window.scrollTo({ top: scrollPosition });
      setDetailWasOpen(false);
    }
  }, [detailWasOpen, scrollPosition, selectedSkillName]);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="skills-heading">
      <ViewHeader headingId="skills-heading" title="Skills">
        {report && (
          <div className={selectedSkillName ? "hidden lg:block" : ""}>
            <StatStrip>
              <Stat label="Skills" value={report.skills.length.toLocaleString("en-US")} />
              <Stat label="Files" value={totalFiles.toLocaleString("en-US")} />
            </StatStrip>
          </div>
        )}
      </ViewHeader>

      {error && <ErrorNotice message={error} onRetry={onRetry} />}
      {report && report.diagnostics.length > 0 && (
        <DiagnosticsBanner diagnostics={report.diagnostics} />
      )}

      {loading && !report ? (
        <div className="card border border-base-300 bg-base-100">
          <LoadingState />
        </div>
      ) : error && !report ? null : !report || !report.directoryExists ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>No skills directory found</EmptyState>
        </div>
      ) : report.skills.length === 0 ? (
        <div className="card border border-base-300 bg-base-100">
          <EmptyState>No skills found</EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
          <div
            className={`card overflow-hidden border border-base-300 bg-base-100 lg:sticky lg:top-[4.25rem] ${
              selectedSkillName ? "hidden lg:block" : ""
            }`}
          >
            <SkillList
              onSelect={openSkill}
              selectedSkillName={selectedSkillName}
              skills={report.skills}
            />
          </div>

          <div className={`min-w-0 ${selectedSkillName ? "" : "hidden lg:block"}`}>
            {selectedSkill ? (
              <SkillDetail
                fileContent={fileContent}
                fileError={fileError}
                fileLoading={fileLoading}
                onBack={onBack}
                onRetryFile={onRetryFile}
                onSelectFile={onSelectFile}
                selectedPath={selectedPath}
                skill={selectedSkill}
              />
            ) : selectedSkillName ? (
              <div className="card border border-base-300 bg-base-100">
                <div className="flex flex-col gap-1 p-3">
                  <BackLink onBack={onBack} />
                </div>
                <EmptyState>Skill not found</EmptyState>
              </div>
            ) : (
              <div className="card border border-base-300 bg-base-100">
                <EmptyState>Select a skill</EmptyState>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SkillList({
  skills,
  selectedSkillName,
  onSelect,
}: {
  skills: readonly SkillSummary[];
  selectedSkillName: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {GROUPS.map((group) => {
        const groupSkills = skills.filter((skill) => groupKeyFor(skill) === group.key);
        if (groupSkills.length === 0) return null;

        return (
          <section className="border-b border-line last:border-b-0" key={group.key}>
            <h2 className="flex items-center justify-between px-3 py-2 text-[0.7rem] font-medium text-ink-faint">
              {group.title}
              <span className="font-mono text-[0.62rem]">{groupSkills.length}</span>
            </h2>
            <ul className="flex flex-col gap-2 px-2.5 pb-2.5">
              {groupSkills.map((skill) => (
                <li key={skill.name}>
                  <SkillCard
                    active={skill.name === selectedSkillName}
                    onSelect={onSelect}
                    skill={skill}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SkillCard({
  skill,
  active,
  onSelect,
}: {
  skill: SkillSummary;
  active: boolean;
  onSelect: (name: string) => void;
}) {
  const ownerOnly =
    !skill.availability.conversation &&
    skill.availability.ownerWorker &&
    !skill.availability.linkedUserWorker;

  return (
    <button
      aria-current={active ? "true" : undefined}
      className={`flex w-full flex-col gap-1.5 rounded border p-2.5 text-left transition-colors hover:border-green/50 hover:bg-surface ${
        active ? "border-green/60 bg-surface" : "border-line bg-surface-muted"
      }`}
      onClick={() => onSelect(skill.name)}
      type="button"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-[0.8rem] font-semibold text-ink">
          {skill.name}
        </span>
        <span className="badge badge-sm badge-ghost shrink-0">
          {fileCountLabel(skill.files.length)}
        </span>
      </span>
      <span className="line-clamp-2 text-[0.72rem] leading-snug text-ink-soft">
        {skill.description}
      </span>
      {(ownerOnly || !skill.modelInvocable) && (
        <span className="flex flex-wrap gap-1">
          {ownerOnly && <span className="badge badge-xs badge-warning badge-soft">Owner only</span>}
          {!skill.modelInvocable && <span className="badge badge-xs badge-ghost">Manual only</span>}
        </span>
      )}
    </button>
  );
}

interface SkillDetailProps {
  skill: SkillSummary;
  selectedPath: string;
  fileContent: SkillFileContent | null;
  fileLoading: boolean;
  fileError: string | null;
  onBack: () => void;
  onSelectFile: (path: string) => void;
  onRetryFile: () => void;
}

function SkillDetail({
  skill,
  selectedPath,
  fileContent,
  fileLoading,
  fileError,
  onBack,
  onSelectFile,
  onRetryFile,
}: SkillDetailProps) {
  return (
    <div className="card overflow-hidden border border-base-300 bg-base-100">
      <div className="flex flex-col gap-3 border-b border-line p-3 sm:p-4">
        <BackLink onBack={onBack} />

        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="break-all font-mono text-[1rem] font-semibold text-ink">{skill.name}</h2>
            <p className="mt-1 text-[0.78rem] leading-relaxed text-ink-soft">{skill.description}</p>
          </div>
          <span className="badge badge-sm badge-ghost shrink-0">
            {fileCountLabel(skill.files.length)}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[0.65rem] font-medium uppercase tracking-wide text-ink-faint">
            Directory
          </span>
          <code className="break-all rounded bg-surface-muted px-2 py-1 font-mono text-[0.7rem] text-ink-soft">
            {skill.directory}
          </code>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.65rem] font-medium uppercase tracking-wide text-ink-faint">
            Availability
          </span>
          <ul className="flex flex-col gap-1.5">
            {AUDIENCES.map((audience) => {
              const available = skill.availability[audience.key];
              return (
                <li
                  className="flex items-start justify-between gap-3 border-b border-line/60 pb-1.5 last:border-b-0 last:pb-0"
                  key={audience.key}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[0.78rem] text-ink">{audience.label}</span>
                    {!available && (
                      <span className="text-[0.68rem] text-ink-faint">
                        {unavailableReason(skill, audience.key)}
                      </span>
                    )}
                  </span>
                  <span
                    className={`badge badge-sm shrink-0 ${
                      available ? "badge-success badge-soft" : "badge-ghost"
                    }`}
                  >
                    {available ? "Available" : "Unavailable"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="border-b border-line p-3">
        {skill.files.length === 0 ? (
          <p className="text-[0.72rem] text-ink-faint">No files</p>
        ) : (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {skill.files.map((file) => (
              <button
                aria-pressed={file.path === selectedPath}
                className={`btn btn-sm min-h-10 shrink-0 font-mono normal-case ${
                  file.path === selectedPath ? "btn-primary" : ""
                }`}
                key={file.path}
                onClick={() => onSelectFile(file.path)}
                type="button"
              >
                {file.path}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-[12rem]">
        {fileLoading ? (
          <LoadingState label="Loading file…" />
        ) : fileError ? (
          <div className="p-3">
            <ErrorNotice message={fileError} onRetry={onRetryFile} />
          </div>
        ) : fileContent ? (
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[0.78rem] leading-6 text-ink">
            {fileContent.content}
          </pre>
        ) : (
          <EmptyState>Select a file</EmptyState>
        )}
      </div>

      <div className="border-t border-line p-3">
        <details>
          <summary className="cursor-pointer text-[0.78rem] font-medium text-ink">
            Prompt entry
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-muted p-2 font-mono text-[0.68rem] leading-relaxed text-ink-soft">
            {skill.promptEntry ?? "Not advertised to the model."}
          </pre>
        </details>
      </div>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      className="btn btn-ghost btn-sm min-h-10 -ml-2 self-start lg:hidden"
      onClick={onBack}
      type="button"
    >
      <span aria-hidden="true">‹</span> Skills
    </button>
  );
}

function DiagnosticsBanner({ diagnostics }: { diagnostics: readonly SkillDiagnostic[] }) {
  return (
    <div className="alert alert-warning alert-soft items-start">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium">Some skills could not be loaded</p>
        <ul className="list-disc space-y-0.5 pl-5 text-[0.75rem]">
          {diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.path ?? ""}:${diagnostic.message}`}>
              {diagnostic.path && (
                <code className="mr-1 font-mono text-[0.7rem]">{diagnostic.path}</code>
              )}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function groupKeyFor(skill: SkillSummary): SkillGroupKey {
  const { conversation, ownerWorker, linkedUserWorker } = skill.availability;
  if (conversation && (ownerWorker || linkedUserWorker)) return "both";
  if (!conversation && (ownerWorker || linkedUserWorker)) return "worker";
  if (conversation) return "conversation";
  return "unavailable";
}

function unavailableReason(skill: SkillSummary, audience: AvailabilityKey): string {
  if (audience === "conversation") {
    if (skill.requirements.includes("browser")) return "Browser tools are worker-only.";
    if (skill.requirements.includes("coding")) return "Coding tools are worker-only.";
    return "The conversation agent does not receive this skill.";
  }
  if (audience === "linkedUserWorker" && skill.requirements.includes("coding")) {
    return "Coding is owner-worker only.";
  }
  if (skill.requirements.includes("browser")) return "Browser tools are not available here.";
  if (skill.requirements.includes("coding")) return "Coding tools are not available here.";
  return "This skill is hidden from this audience.";
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function isDesktop(): boolean {
  return window.matchMedia("(min-width: 1024px)").matches;
}
