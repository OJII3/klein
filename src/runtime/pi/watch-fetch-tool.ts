import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import type { WatchTool } from "@modules/scheduling/application/watch-tool";

const MAX_URLS = 10;
const MAX_CONTENT_CHARS = 64 * 1_024;

export interface WatchFetchCoreResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: {
    readonly urls?: readonly {
      readonly url?: string;
      readonly title?: string;
      readonly content?: string;
      readonly status?: number;
      readonly error?: string | null;
    }[];
  };
}

export interface WatchFetchCore {
  fetchContent(
    params: { url?: string; urls?: string[]; mode?: "raw" | "readable" },
    signal?: AbortSignal,
  ): Promise<WatchFetchCoreResult>;
}

const fetchContentSchema: CodemodeJsonSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch." },
    urls: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_URLS,
      description: "URLs to fetch in parallel.",
    },
    mode: {
      type: "string",
      enum: ["raw", "readable"],
      description:
        "raw returns the exact text; readable extracts Markdown. Watch scripts default to raw.",
    },
  },
  additionalProperties: false,
};

const fetchContentOutputSchema: CodemodeJsonSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          status: { type: "number" },
          error: {
            type: ["string", "null"],
            description: "Why this URL failed; null on success.",
          },
        },
        required: ["url", "title", "content", "error"],
      },
    },
  },
  required: ["urls"],
};

export interface WatchFetchToolOptions {
  readonly agentDir: string;
}

/**
 * The watch-script fetch tool. It reuses pi-web-access's standalone fetch core,
 * which is GET-only and applies its SSRF, domain, redirect, and size policies.
 * The core loads on the first watch check, so normal sessions do not pay for it.
 */
export function createWatchFetchTool(options: WatchFetchToolOptions): WatchTool {
  let core: Promise<WatchFetchCore> | undefined;
  return createWatchFetchToolFromCore(() => (core ??= loadWatchFetchCore(options.agentDir)));
}

export function createWatchFetchToolFromCore(
  core: WatchFetchCore | (() => Promise<WatchFetchCore>),
): WatchTool {
  const getCore = typeof core === "function" ? core : async () => core;
  return {
    name: "fetch_content",
    description:
      "Fetch URLs as text with pi-web-access (HTTP GET only). This is the watch subset of the session's `fetch_content`: only `url`, `urls`, and `mode` (`raw` or `readable`) are accepted. `auth`, `proxy`, `prompt`, `answer`, `extract`, video, and other modes are unavailable. Returns `{ urls: [{ url, title, content, status, error }] }`; `content` is truncated to 64 KiB per URL, per-URL failures are in `error`, and the call fails only when every URL fails.",
    inputSchema: fetchContentSchema,
    outputSchema: fetchContentOutputSchema,
    async execute(args, { signal }) {
      const params = normalizeFetchArgs(args);
      const result = await (await getCore()).fetchContent(params, signal);
      const entries = result.structuredContent?.urls;
      if (!entries || entries.length === 0) {
        throw new Error(textOf(result) || "fetch_content が内容を返しませんでした。");
      }
      const urls = entries.map((entry) => ({
        url: entry.url ?? params.url ?? params.urls?.[0] ?? "",
        title: entry.title ?? "",
        content: (entry.content ?? "").slice(0, MAX_CONTENT_CHARS),
        ...(entry.status === undefined ? {} : { status: entry.status }),
        error: entry.error ?? null,
      }));
      const failed = urls.filter((entry) => entry.error !== null);
      if (failed.length === urls.length) {
        throw new Error(failed.map((entry) => `${entry.url}: ${entry.error}`).join("\n"));
      }
      return { urls };
    },
  };
}

function normalizeFetchArgs(value: unknown): {
  url?: string;
  urls?: string[];
  mode: "raw" | "readable";
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fetch_content には引数オブジェクトを渡してください。");
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : undefined;
  const urls = Array.isArray(record.urls)
    ? record.urls.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : undefined;
  const targets = urls && urls.length > 0 ? urls : url ? [url] : [];
  if (targets.length === 0) {
    throw new Error("fetch_content には url か urls を渡してください。");
  }
  if (targets.length > MAX_URLS) {
    throw new Error(`fetch_content は一度に ${MAX_URLS} URL までです。`);
  }
  for (const target of targets) {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error(`URL が不正です: ${target}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("fetch_content は http と https のみ対応しています。");
    }
  }
  const mode = record.mode ?? "raw";
  if (mode !== "raw" && mode !== "readable") {
    throw new Error('fetch_content の mode は "raw" か "readable" です。');
  }
  return {
    ...(urls && urls.length > 0 ? { urls } : url ? { url } : {}),
    mode,
  };
}

function textOf(result: WatchFetchCoreResult): string {
  return (result.content ?? [])
    .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
    .join("\n")
    .trim();
}

async function loadWatchFetchCore(agentDir: string): Promise<WatchFetchCore> {
  process.env.PI_CODING_AGENT_DIR = resolve(agentDir);
  const module = (await import(
    pathToFileURL(resolve(process.cwd(), "node_modules/pi-web-access/web-tool-core.ts")).href
  )) as { createStandaloneWebToolCore(): WatchFetchCore };
  return module.createStandaloneWebToolCore();
}
