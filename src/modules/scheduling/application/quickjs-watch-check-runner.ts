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
import type { WatchTool } from "./watch-tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1_024 * 1_024;

export interface QuickJsWatchCheckRunnerOptions {
  readonly tools: readonly WatchTool[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly memoryLimitBytes?: number;
}

export class QuickJsWatchCheckRunner implements WatchCheckRunner {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly memoryLimitBytes: number;
  private readonly sandboxTools: CodemodeTool[];

  constructor(options: QuickJsWatchCheckRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.sandboxTools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      execute: (args, { signal }) => tool.execute(args, { signal }),
    }));
  }

  async run(watch: Pick<WatchTask, "script" | "args">): Promise<WatchCheckResult> {
    const startedAt = Date.now();
    const sandbox = new CodemodeSandbox({
      timeoutMs: this.timeoutMs,
      memoryLimitBytes: this.memoryLimitBytes,
      tools: this.sandboxTools,
    });
    try {
      // `store` and `load` are codemode globals, but watch checks do not persist a store. Shadow
      // them so a script that tries to keep state fails loudly instead of silently losing it.
      const result = await sandbox.execute(
        [
          `const args = ${JSON.stringify(watch.args)};`,
          "{",
          '  const store = () => { throw new Error("watch スクリプトでは store() を使えません。状態は実行ごとに保持されません。"); };',
          '  const load = () => { throw new Error("watch スクリプトでは load() を使えません。状態は実行ごとに保持されません。"); };',
          watch.script,
          "}",
        ].join("\n"),
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
        throw new WatchCheckError(
          `監視スクリプトの出力が上限（${this.maxOutputBytes}バイト）を超えました。`,
        );
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
