import type { ComponentChildren } from "preact";

interface ViewHeaderProps {
  headingId: string;
  title: string;
  children?: ComponentChildren;
}

export function ViewHeader({ headingId, title, children }: ViewHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <h1
        className="text-[1.3rem] font-semibold tracking-tight text-ink sm:text-[1.45rem]"
        id={headingId}
      >
        {title}
      </h1>
      {children}
    </div>
  );
}
