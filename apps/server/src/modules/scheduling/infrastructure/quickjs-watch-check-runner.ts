import {
  CodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeOutputItem,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { resolveQuickJsWasmPath } from "@runtime/pi/quickjs-wasm";

import type { WatchTask } from "../domain/scheduled-task";
import {
  WatchCheckError,
  type WatchCheckResult,
  type WatchCheckRunner,
} from "../ports/watch-check-runner";
import type { WatchTool } from "../ports/watch-tool";

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

  async run(watch: Pick<WatchTask, "script" | "args" | "state">): Promise<WatchCheckResult> {
    const startedAt = Date.now();
    const sandbox = new CodemodeSandbox({
      timeoutMs: this.timeoutMs,
      memoryLimitBytes: this.memoryLimitBytes,
      tools: this.sandboxTools,
      wasm: loadQuickJSWasm(resolveQuickJsWasmPath()),
    });
    try {
      const state = { ...watch.state };
      const result = await sandbox.execute(
        [
          `const args = ${JSON.stringify(watch.args)};`,
          "let __watchDecision = null;",
          'const wake = () => { __watchDecision = "wake"; };',
          'const silent = () => { __watchDecision = "silent"; };',
          "await (async () => {",
          watch.script,
          "})();",
          'if (__watchDecision === null) throw new Error("watch script must end by calling wake() or silent()");',
          "return __watchDecision;",
        ].join("\n"),
        { store: state },
      );
      if (!result.ok) {
        throw new WatchCheckError(
          result.error.kind === "timeout"
            ? `watch script timed out after ${this.timeoutMs}ms`
            : `watch script failed: ${result.error.message}`,
        );
      }
      const decision = result.value;
      if (decision !== "wake" && decision !== "silent") {
        throw new WatchCheckError("watch script returned an invalid decision");
      }
      const output = collectOutput(result.output);
      if (Buffer.byteLength(output, "utf8") > this.maxOutputBytes) {
        throw new WatchCheckError(
          `watch script output exceeded the ${this.maxOutputBytes} byte limit`,
        );
      }
      for (const key of result.storeWrites.delete) delete state[key];
      Object.assign(state, result.storeWrites.set);
      return { output, decision, exitCode: 0, durationMs: Date.now() - startedAt, state };
    } finally {
      await sandbox.close();
    }
  }
}

function collectOutput(output: readonly CodemodeOutputItem[]): string {
  return output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}
