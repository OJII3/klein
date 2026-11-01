import {
  CodemodeSandbox,
  type CodemodeOutputItem,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";

import type { WatchTask } from "../domain/scheduled-task";
import {
  WatchCheckError,
  type WatchCheckResult,
  type WatchCheckRunner,
} from "./watch-check-runner";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_FETCH_BODY_CHARS = 64 * 1_024;

export interface QuickJsWatchCheckRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class QuickJsWatchCheckRunner implements WatchCheckRunner {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly fetchGlobal: CodemodeTool = createFetchGlobal();

  constructor(options: QuickJsWatchCheckRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async run(watch: Pick<WatchTask, "script" | "args">): Promise<WatchCheckResult> {
    const startedAt = Date.now();
    const sandbox = new CodemodeSandbox({
      timeoutMs: this.timeoutMs,
      globals: [this.fetchGlobal],
    });
    try {
      const result = await sandbox.execute(
        `const args = ${JSON.stringify(watch.args)};\n${watch.script}`,
      );
      if (!result.ok) {
        throw new WatchCheckError(
          result.error.kind === "timeout"
            ? `監視スクリプトが${this.timeoutMs}msでタイムアウトしました。`
            : `監視スクリプトが失敗しました: ${result.error.message}`,
        );
      }
      const output = collectOutput(result.output, result.value);
      if (Buffer.byteLength(output, "utf8") > this.maxOutputBytes) {
        throw new WatchCheckError("監視スクリプトの出力が上限を超えました。");
      }
      return { output, exitCode: 0, durationMs: Date.now() - startedAt };
    } finally {
      await sandbox.close();
    }
  }
}

function collectOutput(output: readonly CodemodeOutputItem[], value: unknown): string {
  const parts = output.flatMap((item) => (item.type === "text" ? [item.text] : []));
  if (value !== undefined) {
    parts.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return parts.join("\n");
}

function createFetchGlobal(): CodemodeTool {
  return {
    name: "fetch",
    description: "Send an HTTP request and return { status, ok, headers, body }.",
    spread: true,
    async execute(args, { signal }) {
      const [input, init] = Array.isArray(args) ? args : [args];
      if (typeof input !== "string") {
        throw new Error("fetch には URL 文字列を渡してください。");
      }
      const url = new URL(input);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("fetch は http と https のみ対応しています。");
      }
      const response = await globalThis.fetch(url, normalizeRequestInit(init, signal));
      const body = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: body.slice(0, MAX_FETCH_BODY_CHARS),
      };
    },
  };
}

function normalizeRequestInit(init: unknown, signal: AbortSignal): RequestInit {
  const request: RequestInit = { signal };
  if (typeof init !== "object" || init === null) return request;
  const record = init as Record<string, unknown>;
  if (typeof record.method === "string") request.method = record.method;
  if (typeof record.body === "string") request.body = record.body;
  if (typeof record.headers === "object" && record.headers !== null) {
    request.headers = Object.fromEntries(
      Object.entries(record.headers).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    );
  }
  return request;
}
