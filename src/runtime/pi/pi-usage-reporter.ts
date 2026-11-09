import type { Logger } from "pino";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const USAGE_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 20;

export interface PiUsageReporterOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
}

export interface PiUsageRecord {
  readonly id: string;
  readonly ts: number;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number | null;
  readonly sessionId: string;
}

export class PiUsageReporter {
  private readonly buffer: PiUsageRecord[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private flushTimer?: ReturnType<typeof setInterval>;
  private flushPromise: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: PiUsageReporterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.nowImpl = options.now ?? (() => Date.now());
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /**
   * Records the token usage and cost of one completed provider request. The
   * message id keeps retries of the same response from being counted twice.
   */
  recordAssistantMessage(sessionId: string, message: AssistantMessage): void {
    if (this.closed) return;
    const usage = message.usage;
    if (!usage) return;
    if (typeof message.provider !== "string" || typeof message.model !== "string") return;

    this.buffer.push({
      id: `${sessionId}:${message.responseId ?? message.timestamp}`,
      ts: message.timestamp,
      provider: message.provider,
      model: message.model,
      input: usage.input,
      output: usage.output,
      reasoning: usage.reasoning ?? 0,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost?.total ?? null,
      sessionId,
    });
    if (this.buffer.length >= this.maxBatchSize) void this.flush();
  }

  flush(): Promise<void> {
    this.flushPromise = this.flushPromise
      .then(() => this.sendBufferedRecords())
      .catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, event: "usage_report_failed" },
          "Failed to send usage records",
        );
      });
    return this.flushPromise;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private async sendBufferedRecords(): Promise<void> {
    if (this.buffer.length === 0) return;
    const records = this.buffer.splice(0, this.buffer.length);
    const body = JSON.stringify(records);
    const headers = {
      Authorization: `Bearer ${this.options.token}`,
      "Content-Type": "application/json",
    };
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
        });
        if (response.ok) return;
        lastError = new Error(`Usage endpoint returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    this.options.logger.warn(
      { err: lastError, event: "usage_report_failed", recordCount: records.length },
      "Failed to send usage records",
    );
  }
}

export function createPiUsageReporterFromEnv(options: {
  readonly logger: Logger;
  readonly env?: NodeJS.ProcessEnv;
}): PiUsageReporter | undefined {
  const env = options.env ?? process.env;
  const endpoint = env.USAGE_ENDPOINT;
  const token = env.USAGE_TOKEN;
  if (!endpoint || !token) return undefined;

  return new PiUsageReporter({
    endpoint,
    logger: options.logger,
    token,
  });
}
