interface ViewHeaderProps {
  headingId: string;
  title: string;
  description: string;
  count?: string;
}

export function ViewHeader({ headingId, title, description, count }: ViewHeaderProps) {
  return (
    <header className="border-b border-rule pb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-[1.7rem] leading-tight text-ink sm:text-[1.95rem]" id={headingId}>
          {title}
        </h1>
        {count && <p className="shrink-0 font-mono text-xs text-ink-faint">{count}</p>}
      </div>
      <p className="mt-1.5 text-[0.82rem] leading-relaxed text-ink-soft">{description}</p>
    </header>
  );
}
