import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/** Observe Pi without recording prompts, tokens, tool arguments, or HTTP headers. */
export class PiRuntimeTrace {
  private sessionId?: string;
  private runId?: string;
  private inputId?: string;
  private llmCallId?: string;
  private providerRequestId?: string;
  private turnStartedAt = 0;
  private runStartedAt = 0;
  private providerStartedAt?: number;
  private requestPreparedAt?: number;
  private providerTimingAmbiguous = false;
  private streamStarted = false;
  private lastProgressAt = 0;
  private readonly deltas = new Map<string, number>();
  private readonly inputs = new Map<string, string[]>();
  private readonly tools = new Map<string, number>();
  private compactionStartedAt = 0;
  private unsubscribe?: () => void;
  private session?: AgentSession;

  constructor(
    private readonly logger: Logger,
    private readonly now: () => number = () => performance.now(),
  ) {}

  readonly extension: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (_event, context) => {
      if (this.providerTimingAmbiguous) return;
      this.requestPreparedAt = this.now();
      this.log("pi_llm_request_prepared", {
        provider: context.model?.provider,
        model: context.model?.id,
        preparationMs: this.elapsed(this.turnStartedAt),
      });
    });
    pi.on("before_provider_headers", () => {
      if (this.providerTimingAmbiguous) return;
      this.providerRequestId = randomUUID();
      this.providerStartedAt = this.now();
      this.requestPreparedAt = undefined;
      this.streamStarted = false;
      this.log("pi_llm_provider_started");
    });
    pi.on("after_provider_response", (event) => {
      if (this.providerTimingAmbiguous) return;
      this.log("pi_llm_http_response", {
        status: event.status,
        requestWaitMs: this.elapsed(this.requestPreparedAt),
        providerElapsedMs: this.elapsed(this.providerStartedAt),
      });
    });
    pi.on("provider_stream_event", (event) => {
      if (this.providerTimingAmbiguous || this.streamStarted) return;
      this.streamStarted = true;
      this.log("pi_llm_stream_started", {
        provider: event.provider,
        model: event.model,
        requestElapsedMs: this.elapsed(this.requestPreparedAt),
        turnElapsedMs: this.elapsed(this.turnStartedAt),
      });
    });
    pi.on("cache_warming_decision", (event) => {
      // Warming reuses the main request's callbacks. Do not assign its timings to
      // the active LLM turn; normalized generation/tool events remain traceable.
      this.providerTimingAmbiguous = true;
      this.log("pi_provider_timing_ambiguous", {
        reason: "cache_warming_decision",
        action: event.action,
      });
    });
  };

  attach(session: AgentSession): void {
    this.session = session;
    this.sessionId = session.sessionManager.getSessionId();
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
    this.log("pi_session_ready", {
      provider: session.model?.provider,
      model: session.model?.id,
      thinkingLevel: session.thinkingLevel,
      steeringMode: session.steeringMode,
      httpIdleTimeoutMs: session.settingsManager.getHttpIdleTimeoutMs(),
      providerRetry: session.settingsManager.getProviderRetrySettings(),
    });
  }

  registerInput(text: string, traceId: string): void {
    const ids = this.inputs.get(text) ?? [];
    ids.push(traceId);
    this.inputs.set(text, ids);
  }

  removeInput(traceId: string): void {
    for (const [text, ids] of this.inputs) {
      const remaining = ids.filter((id) => id !== traceId);
      if (remaining.length > 0) this.inputs.set(text, remaining);
      else this.inputs.delete(text);
    }
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.info(
      {
        event,
        sessionId: this.sessionId,
        runId: this.runId,
        inputId: this.inputId,
        llmCallId: this.llmCallId,
        providerRequestId: this.providerTimingAmbiguous ? undefined : this.providerRequestId,
        providerTimingAmbiguous: this.providerTimingAmbiguous || undefined,
        ...fields,
      },
      event,
    );
  }

  private elapsed(startedAt: number | undefined): number | undefined {
    return startedAt === undefined ? undefined : Math.round(this.now() - startedAt);
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.runId = randomUUID();
        this.inputId = undefined;
        this.llmCallId = undefined;
        this.providerRequestId = undefined;
        this.providerTimingAmbiguous = this.session?.cacheWarmingStatus?.state === "refreshing";
        this.runStartedAt = this.now();
        this.log("pi_agent_started");
        break;
      case "turn_start":
        this.llmCallId = randomUUID();
        this.providerRequestId = undefined;
        this.turnStartedAt = this.now();
        this.lastProgressAt = this.now();
        this.streamStarted = false;
        this.deltas.clear();
        this.log("pi_turn_started");
        break;
      case "message_start": {
        if (event.message.role !== "user") break;
        const text =
          typeof event.message.content === "string"
            ? event.message.content
            : event.message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        const ids = this.inputs.get(text);
        this.inputId = ids?.shift();
        if (ids?.length === 0) this.inputs.delete(text);
        this.log("pi_input_consumed");
        break;
      }
      case "message_update": {
        const kind = event.assistantMessageEvent.type;
        if (!kind.endsWith("_delta")) break;
        const count = (this.deltas.get(kind) ?? 0) + 1;
        this.deltas.set(kind, count);
        if (count === 1) {
          this.log("pi_llm_first_delta", { kind, turnElapsedMs: this.elapsed(this.turnStartedAt) });
        }
        if (this.now() - this.lastProgressAt >= 5_000) {
          this.lastProgressAt = this.now();
          this.logger.debug(
            {
              event: "pi_llm_progress",
              sessionId: this.sessionId,
              runId: this.runId,
              inputId: this.inputId,
              llmCallId: this.llmCallId,
              providerRequestId: this.providerTimingAmbiguous ? undefined : this.providerRequestId,
              providerTimingAmbiguous: this.providerTimingAmbiguous || undefined,
              turnElapsedMs: this.elapsed(this.turnStartedAt),
              deltas: Object.fromEntries(this.deltas),
            },
            "LLM stream is progressing",
          );
        }
        break;
      }
      case "message_end":
        if (event.message.role !== "assistant") break;
        this.log("pi_llm_completed", {
          provider: event.message.provider,
          model: event.message.model,
          durationMs: this.elapsed(this.turnStartedAt),
          stopReason: event.message.stopReason,
          usage: event.message.usage,
          deltas: Object.fromEntries(this.deltas),
        });
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, this.now());
        this.log("pi_tool_started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          parentToolCallId: event.parentToolCallId,
        });
        break;
      case "tool_execution_end": {
        const startedAt = this.tools.get(event.toolCallId);
        this.tools.delete(event.toolCallId);
        this.log("pi_tool_completed", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          parentToolCallId: event.parentToolCallId,
          isError: event.isError,
          durationMs: startedAt === undefined ? undefined : this.elapsed(startedAt),
        });
        break;
      }
      case "queue_update":
        this.log("pi_queue_updated", {
          steeringCount: event.steering.length,
          followUpCount: event.followUp.length,
        });
        break;
      case "auto_retry_start":
        this.log("pi_retry_scheduled", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        });
        break;
      case "auto_retry_end":
        this.log("pi_retry_completed", { attempt: event.attempt, success: event.success });
        break;
      case "compaction_start":
        this.compactionStartedAt = this.now();
        this.log("pi_compaction_started", { reason: event.reason });
        break;
      case "compaction_end":
        this.log("pi_compaction_completed", {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          durationMs: this.elapsed(this.compactionStartedAt),
        });
        break;
      case "agent_end":
        this.log("pi_agent_ended", {
          durationMs: this.elapsed(this.runStartedAt),
          willRetry: event.willRetry,
        });
        break;
      case "agent_settled":
        this.log("pi_agent_settled", { durationMs: this.elapsed(this.runStartedAt) });
        this.inputs.clear();
        this.runId = undefined;
        this.inputId = undefined;
        this.llmCallId = undefined;
        this.providerRequestId = undefined;
        break;
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session = undefined;
    this.inputs.clear();
    this.tools.clear();
  }
}
