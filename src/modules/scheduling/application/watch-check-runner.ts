import { spawn } from "node:child_process";

import type { CommandWatchTask, ScriptWatchTask, WatchTask } from "../domain/scheduled-task";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;

export interface WatchCheckResult {
  readonly output: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface WatchCheckRunner {
  run(watch: WatchTask): Promise<WatchCheckResult>;
}

export interface WatchCommandRunner {
  run(watch: Pick<CommandWatchTask, "command" | "args">): Promise<WatchCheckResult>;
}

export interface WatchScriptRunner {
  run(watch: Pick<ScriptWatchTask, "script" | "args">): Promise<WatchCheckResult>;
}

export class WatchCheckError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "WatchCheckError";
  }
}

export interface ProcessWatchCheckRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
}

export class ProcessWatchCheckRunner implements WatchCommandRunner {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly cwd: string;

  constructor(options: ProcessWatchCheckRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.cwd = options.cwd ?? process.cwd();
  }

  run(watch: Pick<CommandWatchTask, "command" | "args">): Promise<WatchCheckResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(watch.command, [...watch.args], {
        cwd: this.cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);

      const collect = (target: Buffer[], chunk: Buffer): void => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(() => reject(new WatchCheckError(`監視コマンドの出力が上限を超えました。`)));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => {
        finish(() =>
          reject(new WatchCheckError(`監視コマンドを起動できませんでした: ${error.message}`)),
        );
      });
      child.on("close", (exitCode) => {
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (timedOut) {
          finish(() =>
            reject(
              new WatchCheckError(`監視コマンドが${this.timeoutMs}msでタイムアウトしました。`),
            ),
          );
          return;
        }
        if (exitCode !== 0) {
          finish(() =>
            reject(
              new WatchCheckError(
                `監視コマンドが終了コード ${exitCode ?? "unknown"} で失敗しました。`,
                exitCode ?? undefined,
                stderrText,
              ),
            ),
          );
          return;
        }
        finish(() =>
          resolve({
            output: Buffer.concat(stdout).toString("utf8"),
            exitCode: exitCode ?? 0,
            durationMs: Date.now() - startedAt,
          }),
        );
      });
    });
  }
}
