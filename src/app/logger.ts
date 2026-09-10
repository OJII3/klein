import pino, { type DestinationStream, type Logger } from "pino";

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
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

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}
