import { useEffect, useMemo, useState } from "preact/hooks";

export type Route =
  | { view: "logs" }
  | { view: "sessions"; sessionId: string | null }
  | { view: "memory"; scopeKey: string | null }
  | { view: "tools" };

export type View = Route["view"];

const listeners = new Set<() => void>();

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function navigate(to: string): void {
  const url = new URL(to, window.location.origin);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;

  window.history.pushState(null, "", next);

  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const [href, setHref] = useState(currentHref);
  useEffect(() => {
    const update = () => setHref(currentHref());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return useMemo(() => parseRoute(href), [href]);
}

function parseRoute(href: string): Route {
  const url = new URL(href, "http://localhost");
  const [segment] = url.pathname.split("/").filter(Boolean);

  switch (segment) {
    case "sessions":
      return { sessionId: url.searchParams.get("session") || null, view: "sessions" };
    case "memory":
      return { scopeKey: url.searchParams.get("scope") || null, view: "memory" };
    case "tools":
      return { view: "tools" };
    default:
      return { view: "logs" };
  }
}
