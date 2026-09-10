import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import pino, { type DestinationStream, type Logger } from "pino";

const flushers = new WeakMap<Logger, () => void>();

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
  readonly filePath?: string;
}

export function createLogFilePath(logDirectory: string, now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return resolve(logDirectory, "pino", `${timestamp}_${randomUUID()}.jsonl`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const loggerOptions = {
    name: "klein",
    level: options.level ?? process.env.KLEIN_LOG_LEVEL ?? "info",
    redact: [
      "token",
      "apiKey",
      "authorization",
      "password",
      "secret",
      "config.token",
      "config.apiKey",
      "config.authorization",
      "config.password",
      "config.secret",
    ],
  };

  if (options.destination) return pino(loggerOptions, options.destination);

  if (options.filePath) {
    const stdout = pino.destination(1);
    const file = pino.destination({ dest: options.filePath, mkdir: true, sync: true });
    const streams = pino.multistream([
      { level: loggerOptions.level, stream: stdout },
      { level: loggerOptions.level, stream: file },
    ]);

    const logger = pino(loggerOptions, streams);
    flushers.set(logger, () => streams.flushSync());
    return logger;
  }

  return pino(loggerOptions);
}

export function flushLogger(logger: Logger): void {
  flushers.get(logger)?.();
}
