import type { ComponentChildren } from "preact";

import { navigate } from "../router";

interface LinkProps {
  href: string;
  className?: string;
  "aria-current"?: "page";
  children: ComponentChildren;
}

export function Link({ href, className, "aria-current": ariaCurrent, children }: LinkProps) {
  return (
    <a
      aria-current={ariaCurrent}
      className={className}
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
