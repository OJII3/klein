import { randomBytes } from "node:crypto";

import type { Logger } from "pino";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  SpanAttributes,
  SpanLink,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";

const LANGFUSE_OTEL_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const SERVICE_NAME = "klein";
const SCOPE_NAME = "klein.pi";

export interface PiTelemetryOptions {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly logger: Logger;
  readonly serviceName?: string;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

export interface PiTelemetrySessionOptions {
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly userId?: string;
}

interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedMs: number;
  readonly endedMs: number;
  readonly attributes: SpanAttributes;
  readonly events: readonly {
    readonly name: string;
    readonly timeMs: number;
    readonly attributes: SpanAttributes;
  }[];
  readonly links: readonly {
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes?: SpanAttributes;
  }[];
  readonly status: SpanStatus;
}

interface BeginSpanOptions {
  readonly name: string;
  readonly attributes?: SpanAttributes;
  readonly links?: readonly SpanLink[];
  readonly parent?: OtelSpan;
  readonly traceAttributes: SpanAttributes;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function toErrorInfo(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 500) };
  return { name: "Error", message: String(error).slice(0, 500) };
}

function mergeAttributes(target: SpanAttributes, attributes: SpanAttributes | undefined): void {
  if (!attributes) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) target[key] = value;
  }
}

function messageCharacterCount(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return undefined;
  return content.reduce((total, part) => {
    if (typeof part === "object" && part !== null && "text" in part) {
      const text = (part as { text: unknown }).text;
      if (typeof text === "string") return total + text.length;
    }
    return total;
  }, 0);
}

function usageAttributes(message: unknown): SpanAttributes {
  if (typeof message !== "object" || message === null || !("usage" in message)) return {};
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return {};
  const fields = usage as Record<string, unknown>;
  const attributes: SpanAttributes = {};
  if (typeof fields.input === "number") attributes["gen_ai.usage.input_tokens"] = fields.input;
  if (typeof fields.output === "number") attributes["gen_ai.usage.output_tokens"] = fields.output;
  if (typeof fields.cacheRead === "number") {
    attributes["gen_ai.usage.cache_read.input_tokens"] = fields.cacheRead;
  }
  if (typeof fields.cacheWrite === "number") {
    attributes["gen_ai.usage.cache_creation.input_tokens"] = fields.cacheWrite;
  }
  const cost = fields.cost;
  if (typeof cost === "object" && cost !== null) {
    const total = (cost as { total?: unknown }).total;
    if (typeof total === "number") attributes["gen_ai.usage.cost"] = total;
  }
  return attributes;
}

function usageDetails(message: unknown): Record<string, number> | undefined {
  if (typeof message !== "object" || message === null || !("usage" in message)) return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  const details: Record<string, number> = {};
  if (typeof fields.input === "number") details.input = fields.input;
  if (typeof fields.output === "number") details.output = fields.output;
  if (typeof fields.cacheRead === "number") details.cache_read_input_tokens = fields.cacheRead;
  if (typeof fields.cacheWrite === "number") {
    details.cache_creation_input_tokens = fields.cacheWrite;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function costDetails(message: unknown): Record<string, number> | undefined {
  if (typeof message !== "object" || message === null || !("usage" in message)) return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = (usage as { cost?: unknown }).cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" ? { total } : undefined;
}

function langfuseAttributesForSpan(record: SpanRecord): SpanAttributes {
  const attributes: SpanAttributes = { ...record.attributes };

  if (record.name === "pi.ai.request" || record.name === "pi.ai.poll") {
    attributes["langfuse.observation.type"] = "generation";
    attributes["gen_ai.operation.name"] = "chat";
    const provider = record.attributes.provider ?? record.attributes["gen_ai.provider.name"];
    if (typeof provider === "string") {
      attributes["gen_ai.system"] = provider;
      attributes["gen_ai.provider.name"] = provider;
    }
    const model = record.attributes.model ?? record.attributes["gen_ai.request.model"];
    if (typeof model === "string") {
      attributes["gen_ai.request.model"] = model;
      attributes["langfuse.observation.model.name"] = model;
    }
    const reasoning = record.attributes.reasoning ?? record.attributes["gen_ai.request.reasoning"];
    if (typeof reasoning === "string") attributes["gen_ai.request.reasoning"] = reasoning;
    const stop = record.attributes.stop;
    if (typeof stop === "string") attributes["gen_ai.response.finish_reasons"] = [stop];
    const responseId = record.attributes["response.id"];
    if (typeof responseId === "string") attributes["gen_ai.response.id"] = responseId;

    const usage = usageDetailsFromAttributes(record.attributes);
    if (usage) {
      attributes["langfuse.observation.usage_details"] = JSON.stringify(usage);
      const input = record.attributes["usage.input"];
      const cacheRead = record.attributes["usage.cache_read"];
      const cacheWrite = record.attributes["usage.cache_write"];
      if (typeof input === "number") {
        attributes["gen_ai.usage.input_tokens"] =
          input +
          (typeof cacheRead === "number" ? cacheRead : 0) +
          (typeof cacheWrite === "number" ? cacheWrite : 0);
      }
      if (typeof record.attributes["usage.output"] === "number") {
        attributes["gen_ai.usage.output_tokens"] = record.attributes["usage.output"];
      }
      if (typeof cacheRead === "number") {
        attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
      }
      if (typeof cacheWrite === "number") {
        attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
      }
    }
    const cost = record.attributes["cost.total"];
    if (typeof cost === "number") {
      attributes["gen_ai.usage.cost"] = cost;
      attributes["langfuse.observation.cost_details"] = JSON.stringify({ total: cost });
    }
  } else if (record.name === "klein.tool") {
    attributes["langfuse.observation.type"] = "tool";
    attributes["gen_ai.operation.name"] = "execute_tool";
  } else if (record.name === "klein.agent") {
    attributes["langfuse.observation.type"] = "agent";
    attributes["gen_ai.operation.name"] = "invoke_agent";
    attributes["gen_ai.agent.name"] = SERVICE_NAME;
  } else {
    attributes["langfuse.observation.type"] = "span";
  }

  return attributes;
}

function usageDetailsFromAttributes(
  attributes: SpanAttributes,
): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  const input = attributes["usage.input"];
  const output = attributes["usage.output"];
  const cacheRead = attributes["usage.cache_read"];
  const cacheWrite = attributes["usage.cache_write"];
  if (typeof input === "number") details.input = input;
  if (typeof output === "number") details.output = output;
  if (typeof cacheRead === "number") details.cache_read_input_tokens = cacheRead;
  if (typeof cacheWrite === "number") details.cache_creation_input_tokens = cacheWrite;
  return Object.keys(details).length > 0 ? details : undefined;
}

function toOtlpValue(
  value: string | number | boolean | readonly string[] | readonly number[] | readonly boolean[],
): unknown {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return {
    arrayValue: {
      values: value.map((item) => toOtlpValue(item)),
    },
  };
}

function toOtlpAttributes(attributes: SpanAttributes): Array<{ key: string; value: unknown }> {
  const result: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result.push({ key, value: toOtlpValue(value) });
  }
  return result;
}

function toUnixNano(milliseconds: number): string {
  return BigInt(Math.round(milliseconds * 1_000_000)).toString();
}

function toOtlpSpan(record: SpanRecord): Record<string, unknown> {
  const attributes = langfuseAttributesForSpan(record);
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    name: record.name,
    kind: 1,
    startTimeUnixNano: toUnixNano(record.startedMs),
    endTimeUnixNano: toUnixNano(record.endedMs),
    attributes: toOtlpAttributes(attributes),
    events: record.events.map((event) => ({
      name: event.name,
      timeUnixNano: toUnixNano(event.timeMs),
      attributes: toOtlpAttributes(event.attributes),
    })),
    links: record.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: toOtlpAttributes(link.attributes ?? {}),
    })),
    status:
      record.status.status === "error"
        ? {
            code: 2,
            ...(record.status.error?.message ? { message: record.status.error.message } : {}),
          }
        : { code: 1 },
  };
}

export class OtelSpan implements TelemetrySpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedMs: number;
  readonly traceAttributes: SpanAttributes;

  private readonly attributes: SpanAttributes = {};
  private readonly events: Array<{
    name: string;
    timeMs: number;
    attributes: SpanAttributes;
  }> = [];
  private readonly links: Array<{
    traceId: string;
    spanId: string;
    attributes?: SpanAttributes;
  }> = [];
  private status: SpanStatus = { status: "ok" };
  private endedMs?: number;
  private ended = false;

  constructor(
    private readonly telemetry: PiTelemetry,
    options: BeginSpanOptions,
  ) {
    this.traceId = options.parent?.traceId ?? randomHex(16);
    this.spanId = randomHex(8);
    this.parentSpanId = options.parent?.spanId;
    this.name = options.name;
    this.startedMs = telemetry.now();
    this.traceAttributes = options.traceAttributes;
    mergeAttributes(this.attributes, options.traceAttributes);
    mergeAttributes(this.attributes, options.attributes);
    for (const link of options.links ?? []) this.addLink(link);
  }

  async startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const child = this.telemetry.beginSpan({
      name: options.name,
      attributes: options.attributes,
      links: options.links,
      parent: this,
      traceAttributes: this.traceAttributes,
    });

    try {
      const result = await callback(child);
      child.end();
      return result;
    } catch (error) {
      child.setStatus({ status: "error", error: toErrorInfo(error) });
      child.end();
      throw error;
    }
  }

  addLink(link: SpanLink): void {
    if (this.ended) return;
    if (!(link.context instanceof OtelSpan)) return;
    this.links.push({
      traceId: link.context.traceId,
      spanId: link.context.spanId,
      ...(link.attributes ? { attributes: { ...link.attributes } } : {}),
    });
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.ended) return;
    this.events.push({
      name,
      timeMs: this.telemetry.now(),
      attributes: { ...attributes },
    });
  }

  setAttributes(attributes: SpanAttributes): void {
    if (this.ended) return;
    mergeAttributes(this.attributes, attributes);
  }

  setStatus(status: SpanStatus): void {
    if (this.ended) return;
    this.status = status;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.endedMs = this.telemetry.now();
    this.telemetry.enqueue({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      startedMs: this.startedMs,
      endedMs: this.endedMs,
      attributes: { ...this.attributes },
      events: this.events.map((event) => ({ ...event, attributes: { ...event.attributes } })),
      links: this.links.map((link) => ({
        ...link,
        ...(link.attributes ? { attributes: { ...link.attributes } } : {}),
      })),
      status: this.status,
    });
  }
}

export class PiTelemetrySession implements TelemetryContext {
  private agentSpan?: OtelSpan;
  private turnSpan?: OtelSpan;
  private generationSpan?: OtelSpan;
  private compactionSpan?: OtelSpan;
  private readonly toolSpans = new Map<string, OtelSpan>();
  private turnIndex = 0;
  private readonly traceAttributes: SpanAttributes;

  constructor(
    private readonly telemetry: PiTelemetry,
    readonly options: PiTelemetrySessionOptions,
  ) {
    this.traceAttributes = {
      "langfuse.session.id": options.sessionKey,
      "langfuse.trace.name": "klein.agent",
      "langfuse.trace.tags": ["pi", "discord"],
      "langfuse.trace.metadata.session_key": options.sessionKey,
      "langfuse.trace.metadata.session_id": options.sessionId,
      ...(options.userId ? { "langfuse.user.id": options.userId } : {}),
      ...(options.provider ? { "langfuse.trace.metadata.provider": options.provider } : {}),
      ...(options.model ? { "langfuse.trace.metadata.model": options.model } : {}),
      ...(options.thinkingLevel
        ? { "langfuse.trace.metadata.thinking_level": options.thinkingLevel }
        : {}),
    };
  }

  async startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const span = this.telemetry.beginSpan({
      name: options.name,
      attributes: options.attributes,
      links: options.links,
      traceAttributes: this.traceAttributes,
    });

    try {
      const result = await callback(span);
      span.end();
      return result;
    } catch (error) {
      span.setStatus({ status: "error", error: toErrorInfo(error) });
      span.end();
      throw error;
    }
  }

  currentSpan(): TelemetrySpan | undefined {
    return this.turnSpan ?? this.agentSpan;
  }

  startAgent(attributes: SpanAttributes = {}): void {
    this.agentSpan?.end();
    this.agentSpan = this.telemetry.beginSpan({
      name: "klein.agent",
      attributes,
      traceAttributes: this.traceAttributes,
    });
  }

  startTurn(attributes: SpanAttributes = {}): void {
    this.generationSpan?.end();
    this.generationSpan = undefined;
    this.turnSpan?.end();
    this.turnIndex += 1;
    this.turnSpan = this.telemetry.beginSpan({
      name: "klein.turn",
      attributes: { "turn.index": this.turnIndex, ...attributes },
      parent: this.agentSpan,
      traceAttributes: this.traceAttributes,
    });
  }

  endTurn(attributes: SpanAttributes = {}): void {
    this.generationSpan?.end();
    this.generationSpan = undefined;
    this.turnSpan?.setAttributes(attributes);
    this.turnSpan?.end();
    this.turnSpan = undefined;
  }

  setTurnAttributes(attributes: SpanAttributes): void {
    this.turnSpan?.setAttributes(attributes);
  }

  recordAssistantMessage(message: unknown): void {
    const stopReason =
      typeof message === "object" && message !== null && "stopReason" in message
        ? (message as { stopReason?: unknown }).stopReason
        : undefined;
    const generation: SpanAttributes = {
      ...usageAttributes(message),
      ...(typeof stopReason === "string" ? { "gen_ai.response.finish_reasons": [stopReason] } : {}),
    };
    const details = usageDetails(message);
    if (details) generation["langfuse.observation.usage_details"] = JSON.stringify(details);
    const cost = costDetails(message);
    if (cost) generation["langfuse.observation.cost_details"] = JSON.stringify(cost);
    this.turnSpan?.setAttributes(generation);
    const chars = messageCharacterCount(message);
    if (chars !== undefined) this.turnSpan?.setAttributes({ "output.chars": chars });
    this.generationSpan?.setAttributes(generation);
    this.generationSpan?.end();
    this.generationSpan = undefined;
  }

  /**
   * Opens the generation span for one provider request. Pi's own `pi.ai.request`
   * spans only come from its `Models` facade, and `ModelRuntime` calls providers
   * directly, so the request is timed from the session events instead.
   */
  startGeneration(attributes: SpanAttributes): void {
    this.generationSpan?.end();
    this.generationSpan = this.telemetry.beginSpan({
      name: "pi.ai.request",
      attributes: {
        "gen_ai.operation.name": "chat",
        ...(this.options.provider ? { "gen_ai.provider.name": this.options.provider } : {}),
        ...(this.options.model ? { "gen_ai.request.model": this.options.model } : {}),
        ...(this.options.thinkingLevel
          ? { "gen_ai.request.reasoning": this.options.thinkingLevel }
          : {}),
        ...attributes,
      },
      parent: this.turnSpan ?? this.agentSpan,
      traceAttributes: this.traceAttributes,
    });
  }

  endGeneration(attributes: SpanAttributes = {}): void {
    this.generationSpan?.setAttributes(attributes);
    this.generationSpan?.end();
    this.generationSpan = undefined;
  }

  recordUserMessage(message: unknown): void {
    const chars = messageCharacterCount(message);
    if (chars !== undefined) this.turnSpan?.setAttributes({ "input.chars": chars });
  }

  recordToolResult(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const isError = "isError" in message && (message as { isError?: unknown }).isError === true;
    this.turnSpan?.addEvent("pi.tool_result", { "tool.error": isError });
  }

  startTool(toolCallId: string, toolName: string): void {
    const span = this.telemetry.beginSpan({
      name: "klein.tool",
      attributes: {
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": toolCallId,
      },
      parent: this.turnSpan ?? this.agentSpan,
      traceAttributes: this.traceAttributes,
    });
    this.toolSpans.set(toolCallId, span);
  }

  endTool(toolCallId: string, attributes: SpanAttributes = {}): void {
    const span = this.toolSpans.get(toolCallId);
    if (!span) return;
    this.toolSpans.delete(toolCallId);
    span.setAttributes(attributes);
    span.end();
  }

  startCompaction(reason: string): void {
    this.compactionSpan?.end();
    this.compactionSpan = this.telemetry.beginSpan({
      name: "klein.compaction",
      attributes: { "compaction.reason": reason },
      parent: this.agentSpan,
      traceAttributes: this.traceAttributes,
    });
  }

  endCompaction(attributes: SpanAttributes = {}): void {
    this.compactionSpan?.setAttributes(attributes);
    this.compactionSpan?.end();
    this.compactionSpan = undefined;
  }

  addAgentEvent(name: string, attributes?: SpanAttributes): void {
    this.agentSpan?.addEvent(name, attributes);
  }

  setAgentAttributes(attributes: SpanAttributes): void {
    this.agentSpan?.setAttributes(attributes);
  }

  endAgent(attributes: SpanAttributes = {}): void {
    this.generationSpan?.end();
    this.generationSpan = undefined;
    for (const span of this.toolSpans.values()) span.end();
    this.toolSpans.clear();
    this.endCompaction();
    this.endTurn();
    this.agentSpan?.setAttributes(attributes);
    this.agentSpan?.end();
    this.agentSpan = undefined;
  }

  dispose(): void {
    this.endAgent({ "agent.abandoned": true });
  }
}

export class PiTelemetry {
  private readonly buffer: SpanRecord[] = [];
  private readonly sessions = new Map<string, PiTelemetrySession>();
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly resourceAttributes: SpanAttributes;
  private flushTimer?: ReturnType<typeof setInterval>;
  private flushPromise: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: PiTelemetryOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.nowImpl = options.now ?? (() => Date.now());
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.resourceAttributes = {
      "service.name": options.serviceName ?? SERVICE_NAME,
      "service.version": "0.1.0",
      "telemetry.sdk.name": SCOPE_NAME,
      "telemetry.sdk.language": "typescript",
      "deployment.environment": process.env.NODE_ENV ?? "development",
    };
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  now(): number {
    return this.nowImpl();
  }

  createSession(options: PiTelemetrySessionOptions): PiTelemetrySession {
    const session = new PiTelemetrySession(this, options);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  removeSession(sessionId: string): void {
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string | undefined): PiTelemetrySession | undefined {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  currentSpan(sessionId: string | undefined): TelemetrySpan | undefined {
    return this.getSession(sessionId)?.currentSpan();
  }

  beginSpan(options: BeginSpanOptions): OtelSpan {
    return new OtelSpan(this, options);
  }

  enqueue(record: SpanRecord): void {
    if (this.closed) return;
    this.buffer.push(record);
    if (this.buffer.length >= this.maxBatchSize) void this.flush();
  }

  flush(): Promise<void> {
    this.flushPromise = this.flushPromise
      .then(() => this.sendBufferedSpans())
      .catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, event: "langfuse_otel_export_failed" },
          "Failed to prepare telemetry for Langfuse",
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

  private async sendBufferedSpans(): Promise<void> {
    if (this.buffer.length === 0) return;
    const spans = this.buffer.splice(0, this.buffer.length);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: toOtlpAttributes(this.resourceAttributes) },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME, version: "0.1.0" },
              spans: spans.map(toOtlpSpan),
            },
          ],
        },
      ],
    };

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
    const headers = {
      Authorization: `Basic ${Buffer.from(
        `${this.options.publicKey}:${this.options.secretKey}`,
      ).toString("base64")}`,
      "Content-Type": "application/json",
      "x-langfuse-ingestion-version": "4",
    };
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(LANGFUSE_OTEL_TIMEOUT_MS),
        });
        if (response.ok) return;
        lastError = new Error(`Langfuse returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    this.options.logger.warn(
      { err: lastError, event: "langfuse_otel_export_failed", spanCount: spans.length },
      "Failed to export telemetry to Langfuse",
    );
  }
}

export function createPiTelemetryFromEnv(options: {
  readonly logger: Logger;
  readonly env?: NodeJS.ProcessEnv;
}): PiTelemetry | undefined {
  const env = options.env ?? process.env;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;

  const tracing = env.LANGFUSE_TRACING?.toLowerCase();
  if (tracing !== undefined && !["1", "true", "yes", "on"].includes(tracing)) return undefined;

  return new PiTelemetry({
    baseUrl: env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    logger: options.logger,
    publicKey,
    secretKey,
  });
}

/**
 * Adds the current Pi telemetry span to model requests so pi-ai can emit its
 * `pi.ai.request` spans as children of the active agent turn.
 */
export function withPiTelemetry(
  modelRuntime: ModelRuntime,
  telemetry: PiTelemetry,
  fallbackSessionId?: string,
): ModelRuntime {
  const resolveSessionId = (options?: { sessionId?: string }): string | undefined => {
    if (options?.sessionId && telemetry.getSession(options.sessionId)) return options.sessionId;
    return fallbackSessionId;
  };

  return new Proxy(modelRuntime, {
    get(target, property) {
      if (property === "streamSimple" || property === "stream") {
        const stream = property === "stream" ? target.stream : target.streamSimple;
        return (model: never, context: never, options?: { sessionId?: string }) => {
          const span = telemetry.currentSpan(resolveSessionId(options));
          return span
            ? stream.call(target, model, context, { ...options, telemetry: span })
            : stream.call(target, model, context, options);
        };
      }

      if (property === "completeSimple" || property === "complete") {
        const complete = property === "complete" ? target.complete : target.completeSimple;
        return async (model: never, context: never, options?: { sessionId?: string }) => {
          const session = telemetry.getSession(resolveSessionId(options));
          const span = session?.currentSpan();
          if (span) {
            return complete.call(target, model, context, { ...options, telemetry: span });
          }
          if (session) {
            return session.startSpan({ name: "klein.background" }, (root) =>
              complete.call(target, model, context, { ...options, telemetry: root }),
            );
          }
          return complete.call(target, model, context, options);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
