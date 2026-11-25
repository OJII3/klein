import { spawn } from "node:child_process";

import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import type { WatchTool } from "@modules/scheduling/ports/watch-tool";
import { isRecord } from "@shared/type-guards";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1_000;
const GH_TOKEN_TIMEOUT_MS = 5_000;
const MAX_PATH_LENGTH = 500;
const MAX_QUERY_KEYS = 30;
const MAX_ETAG_LENGTH = 200;

export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WatchGitHubApiToolOptions {
  readonly fetchImpl?: GitHubFetch;
  readonly resolveToken?: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly maxResponseBytes?: number;
  readonly tokenCacheTtlMs?: number;
  readonly now?: () => number;
}

const githubApiInputSchema: CodemodeJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        'GitHub REST API path starting with "/", for example "/repos/owner/repo/issues" or "/repos/owner/repo/pulls".',
    },
    query: {
      type: "object",
      description: "Optional query parameters (string, number, or boolean values).",
      additionalProperties: {
        type: ["string", "number", "boolean"],
      },
    },
    etag: {
      type: "string",
      description:
        "Optional ETag from a previous response, sent as If-None-Match so unchanged responses return 304 without consuming rate limit.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const githubApiOutputSchema: CodemodeJsonSchema = {
  type: "object",
  properties: {
    status: { type: "number" },
    notModified: { type: "boolean" },
    etag: { type: ["string", "null"] },
    rateLimitRemaining: { type: ["number", "null"] },
    data: {},
  },
  required: ["status", "notModified", "etag", "rateLimitRemaining", "data"],
};

export function createWatchGitHubApiTool(options: WatchGitHubApiToolOptions = {}): WatchTool {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveToken = options.resolveToken ?? resolveHostGitHubToken;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const tokenCacheTtlMs = options.tokenCacheTtlMs ?? TOKEN_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  let cachedToken: { value: string | undefined; expiresAt: number } | undefined;

  async function getToken(
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!forceRefresh && cachedToken && now() < cachedToken.expiresAt) {
      return cachedToken.value;
    }
    const value = await resolveToken(signal);
    cachedToken = { value, expiresAt: now() + tokenCacheTtlMs };
    return value;
  }

  return {
    name: "github_api",
    audience: "owner",
    description:
      "Read-only GitHub REST API client (HTTP GET against https://api.github.com) using host authentication without exposing tokens to the watch script. Supports ETag conditional requests via `etag` (returns `{ status: 304, notModified: true, data: null }` when unchanged). Keep responses compact with query parameters such as `per_page`.",
    inputSchema: githubApiInputSchema,
    outputSchema: githubApiOutputSchema,
    async execute(args, { signal }) {
      const params = normalizeGitHubApiArgs(args);
      const url = buildGitHubApiUrl(params.path, params.query);
      let token = await getToken(false, signal);
      let response = await sendRequest(fetchImpl, url, token, params.etag, signal);

      if (response.status === 401 && token !== undefined) {
        const refreshed = await getToken(true, signal);
        if (refreshed !== token) {
          token = refreshed;
          response = await sendRequest(fetchImpl, url, token, params.etag, signal);
        }
      }

      const etag = response.headers.get("etag");
      const rateLimitRemaining = parseRateLimitRemaining(
        response.headers.get("x-ratelimit-remaining"),
      );

      if (response.status === 304) {
        return {
          status: 304,
          notModified: true,
          etag: etag ?? params.etag ?? null,
          rateLimitRemaining,
          data: null,
        };
      }

      const body = await readBoundedText(response, maxResponseBytes);
      if (!response.ok) {
        const detail = extractGitHubErrorMessage(body);
        throw new Error(
          `GitHub API GET ${params.path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }

      let data: unknown = null;
      if (body.trim().length > 0) {
        try {
          data = JSON.parse(body);
        } catch (error) {
          throw new Error(`GitHub API GET ${params.path} returned non-JSON response`, {
            cause: error,
          });
        }
      }

      return {
        status: response.status,
        notModified: false,
        etag,
        rateLimitRemaining,
        data,
      };
    },
  };
}

interface NormalizedGitHubApiArgs {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly etag?: string;
}

function normalizeGitHubApiArgs(value: unknown): NormalizedGitHubApiArgs {
  if (!isRecord(value)) {
    throw new Error("github_api requires an argument object.");
  }
  const path = typeof value.path === "string" ? value.path.trim() : "";
  validateGitHubApiPath(path);

  let query: Record<string, string> | undefined;
  if (value.query !== undefined) {
    if (!isRecord(value.query)) {
      throw new Error("github_api `query` must be an object.");
    }
    const entries = Object.entries(value.query);
    if (entries.length > MAX_QUERY_KEYS) {
      throw new Error(`github_api accepts at most ${MAX_QUERY_KEYS} query parameters.`);
    }
    query = {};
    for (const [key, raw] of entries) {
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        throw new TypeError(
          `github_api query parameter "${key}" must be a string, number, or boolean.`,
        );
      }
      query[key] = String(raw);
    }
  }

  let etag: string | undefined;
  if (value.etag !== undefined) {
    if (typeof value.etag !== "string") {
      throw new TypeError("github_api `etag` must be a string.");
    }
    const trimmed = value.etag.trim();
    if (trimmed.length > MAX_ETAG_LENGTH || /[\r\n]/u.test(trimmed)) {
      throw new Error("github_api `etag` is invalid.");
    }
    if (trimmed.length > 0) etag = trimmed;
  }

  return {
    path,
    ...(query ? { query } : {}),
    ...(etag ? { etag } : {}),
  };
}

function validateGitHubApiPath(path: string): void {
  if (!path.startsWith("/") || path.length > MAX_PATH_LENGTH) {
    throw new Error('github_api `path` must start with "/" and be at most 500 characters.');
  }
  if (
    path.startsWith("//") ||
    path.includes("://") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    hasControlOrWhitespace(path)
  ) {
    throw new Error(`github_api path is invalid: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`github_api path must not contain "..": ${path}`);
  }
}

function hasControlOrWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function buildGitHubApiUrl(path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.origin !== GITHUB_API_ORIGIN) {
    throw new Error(`github_api resolved outside ${GITHUB_API_ORIGIN}`);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function sendRequest(
  fetchImpl: GitHubFetch,
  url: string,
  token: string | undefined,
  etag: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "klein-watch",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal,
  });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `GitHub API response exceeded ${maxBytes} bytes; narrow the request with query parameters such as per_page.`,
      );
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(
        `GitHub API response exceeded ${maxBytes} bytes; narrow the request with query parameters such as per_page.`,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `GitHub API response exceeded ${maxBytes} bytes; narrow the request with query parameters such as per_page.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRateLimitRemaining(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractGitHubErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message.slice(0, 300);
    }
  } catch {}
  return trimmed.slice(0, 300);
}

// External: fall back to `gh auth token` so owner watches reuse host gh credentials without storing a separate secret.
async function resolveHostGitHubToken(signal?: AbortSignal): Promise<string | undefined> {
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) return envToken;
  return readGhCliToken(signal);
}

function readGhCliToken(signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }

    const child = spawn("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;

    const finish = (token: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(token);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(undefined);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(undefined);
    }, GH_TOKEN_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 4_096) stdout += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      const token = code === 0 ? stdout.trim() : "";
      finish(token.length > 0 ? token : undefined);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
