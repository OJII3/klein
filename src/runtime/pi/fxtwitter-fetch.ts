import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const FXTWITTER_API_BASE_URL = "https://api.fxtwitter.com/2/status";
const X_HOSTNAMES = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);
const STATUS_PATH_PATTERN = /^\/(?:[^/]+\/)?status\/(\d{2,20})(?:\/(?:photo|video)\/\d+)?\/?$/i;

export function toFxTwitterApiUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (!X_HOSTNAMES.has(url.hostname.toLowerCase())) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const match = url.pathname.match(STATUS_PATH_PATTERN);
  if (!match) return undefined;

  return `${FXTWITTER_API_BASE_URL}/${match[1]}`;
}

export function rewriteFxtwitterFetchInput(input: Record<string, unknown>): void {
  if (typeof input.url === "string") {
    input.url = toFxTwitterApiUrl(input.url) ?? input.url;
  }

  if (Array.isArray(input.urls)) {
    input.urls = input.urls.map((value) =>
      typeof value === "string" ? (toFxTwitterApiUrl(value) ?? value) : value,
    );
  }
}

export function createFxtwitterFetchExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "fetch_content") return;

      rewriteFxtwitterFetchInput(event.input as Record<string, unknown>);
    });
  };
}
