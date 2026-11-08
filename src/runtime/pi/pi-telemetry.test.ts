import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { createLogger } from "@app/logger";
import {
  createPiTelemetryFromEnv,
  PiTelemetry,
  withPiTelemetry,
  type PiTelemetrySession,
} from "./pi-telemetry";
import { PiRuntimeTrace } from "./pi-runtime-trace";

function createTestLogger() {
  return createLogger({
    level: "debug",
    destination: { write: () => undefined },
  });
}

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function createTelemetry() {
  const requests: CapturedRequest[] = [];
  let now = 1_700_000_000_000;
  const telemetry = new PiTelemetry({
    baseUrl: "https://cloud.langfuse.com",
    flushIntervalMs: 0,
    logger: createTestLogger(),
    now: () => {
      now += 1;
      return now;
    },
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await request.json(),
      });
      return new Response(null, { status: 204 });
    },
  });
  return { telemetry, requests };
}

function createSession(telemetry: PiTelemetry): PiTelemetrySession {
  return telemetry.createSession({
    sessionId: "session-1",
    sessionKey: "channel-1",
    provider: "mistral",
    model: "mistral-large-latest",
    thinkingLevel: "medium",
    userId: "owner-1",
  });
}

function spansFrom(request: CapturedRequest): Array<Record<string, unknown>> {
  const body = request.body as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
  };
  return body.resourceSpans[0]!.scopeSpans[0]!.spans;
}

function attributesOf(span: Record<string, unknown>): Record<string, unknown> {
  const attributes = span.attributes as Array<{ key: string; value: Record<string, unknown> }>;
  return Object.fromEntries(
    attributes.map(({ key, value }) => {
      if ("stringValue" in value) return [key, value.stringValue];
      if ("intValue" in value) return [key, Number(value.intValue)];
      if ("doubleValue" in value) return [key, value.doubleValue];
      if ("boolValue" in value) return [key, value.boolValue];
      if ("arrayValue" in value) {
        const values = (value.arrayValue as { values: Array<Record<string, unknown>> }).values;
        return [key, values.map((item) => item.stringValue ?? item.intValue ?? item.boolValue)];
      }
      return [key, value];
    }),
  );
}

test("exports Pi spans to Langfuse OTLP with generations, tools, and trace context", async () => {
  const { telemetry, requests } = createTelemetry();
  const session = createSession(telemetry);

  session.startAgent();
  session.startTurn();
  const turn = session.currentSpan();
  assert.ok(turn);

  await turn.startSpan(
    {
      name: "pi.ai.request",
      attributes: {
        provider: "mistral",
        api: "mistral-conversations",
        model: "mistral-large-latest",
        reasoning: "medium",
      },
    },
    async (span) => {
      span.addEvent("pi.ai.first_chunk");
      span.setAttributes({
        stop: "stop",
        "usage.input": 100,
        "usage.output": 50,
        "usage.cache_read": 10,
        "usage.cache_write": 5,
        "cost.total": 0.01,
        "response.id": "resp-1",
      });
    },
  );

  session.startTool("call-1", "discord_send");
  session.endTool("call-1", { "tool.is_error": false });
  session.endTurn();
  session.endAgent();
  await telemetry.flush();

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://cloud.langfuse.com/api/public/otel/v1/traces");
  assert.equal(
    request.headers.get("authorization"),
    `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
  );
  assert.equal(request.headers.get("x-langfuse-ingestion-version"), "4");

  const spans = spansFrom(request);
  assert.equal(spans.length, 4);
  const byName = new Map(spans.map((span) => [span.name, span]));
  const agent = byName.get("klein.agent")!;
  const turnSpan = byName.get("klein.turn")!;
  const generation = byName.get("pi.ai.request")!;
  const tool = byName.get("klein.tool")!;

  assert.equal(agent.parentSpanId, undefined);
  assert.equal(turnSpan.parentSpanId, agent.spanId);
  assert.equal(generation.parentSpanId, turnSpan.spanId);
  assert.equal(tool.parentSpanId, turnSpan.spanId);
  assert.equal(generation.traceId, agent.traceId);
  assert.equal(tool.traceId, agent.traceId);

  const generationAttributes = attributesOf(generation);
  assert.equal(generationAttributes["langfuse.observation.type"], "generation");
  assert.equal(generationAttributes["gen_ai.request.model"], "mistral-large-latest");
  assert.equal(generationAttributes["gen_ai.provider.name"], "mistral");
  assert.deepEqual(generationAttributes["gen_ai.response.finish_reasons"], ["stop"]);
  assert.deepEqual(
    JSON.parse(generationAttributes["langfuse.observation.usage_details"] as string),
    {
      input: 100,
      output: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  );
  assert.deepEqual(
    JSON.parse(generationAttributes["langfuse.observation.cost_details"] as string),
    { total: 0.01 },
  );
  assert.equal(generationAttributes["langfuse.session.id"], "channel-1");
  assert.equal(generationAttributes["langfuse.user.id"], "owner-1");

  const toolAttributes = attributesOf(tool);
  assert.equal(toolAttributes["langfuse.observation.type"], "tool");
  assert.equal(toolAttributes["gen_ai.tool.name"], "discord_send");
  assert.equal(toolAttributes["gen_ai.tool.call.id"], "call-1");

  const agentAttributes = attributesOf(agent);
  assert.equal(agentAttributes["langfuse.observation.type"], "agent");
  assert.equal(agentAttributes["langfuse.trace.name"], "klein.agent");
  assert.deepEqual(agentAttributes["langfuse.trace.tags"], ["pi", "discord"]);
});

test("exports error statuses and span events", async () => {
  const { telemetry, requests } = createTelemetry();
  const session = createSession(telemetry);

  session.startAgent();
  session.startTurn();
  const turn = session.currentSpan();
  assert.ok(turn);

  await assert.rejects(
    turn.startSpan({ name: "pi.ai.request" }, async (span) => {
      span.addEvent("pi.ai.first_chunk");
      throw new Error("provider exploded");
    }),
    /provider exploded/,
  );

  session.endTurn();
  session.endAgent();
  await telemetry.flush();

  const generation = spansFrom(requests[0]!).find((span) => span.name === "pi.ai.request")!;
  assert.deepEqual(generation.status, {
    code: 2,
    message: "provider exploded",
  });
  const events = generation.events as Array<{ name: string }>;
  assert.deepEqual(
    events.map((event) => event.name),
    ["pi.ai.first_chunk"],
  );
});

test("injects the active turn span into Pi model requests", async () => {
  const { telemetry } = createTelemetry();
  const session = createSession(telemetry);
  session.startAgent();
  session.startTurn();
  const turn = session.currentSpan();

  const calls: Array<{ telemetry?: unknown }> = [];
  const modelRuntime = {
    completeSimple: async (
      _model: unknown,
      _context: unknown,
      options?: { telemetry?: unknown },
    ) => {
      calls.push(options ?? {});
      return {};
    },
    streamSimple: (_model: unknown, _context: unknown, options?: { telemetry?: unknown }) => {
      calls.push(options ?? {});
      return {};
    },
  } as unknown as ModelRuntime;

  const wrapped = withPiTelemetry(modelRuntime, telemetry);
  wrapped.streamSimple({} as never, {} as never, { sessionId: "session-1" });
  await wrapped.completeSimple({} as never, {} as never, { sessionId: "session-1" });

  assert.equal(calls[0]?.telemetry, turn);
  assert.equal(calls[1]?.telemetry, turn);

  session.endTurn();
  session.endAgent();
  await telemetry.flush();
});

test("traces background completions when no turn is active", async () => {
  const { telemetry, requests } = createTelemetry();
  createSession(telemetry);

  const modelRuntime = {
    completeSimple: async (
      _model: unknown,
      _context: unknown,
      options?: { telemetry?: unknown },
    ) => {
      assert.ok(options?.telemetry);
      return {};
    },
  } as unknown as ModelRuntime;

  const wrapped = withPiTelemetry(modelRuntime, telemetry, "session-1");
  await wrapped.completeSimple({} as never, {} as never, { sessionId: "background-job" });
  await telemetry.flush();

  const spans = spansFrom(requests[0]!);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "klein.background");
  assert.equal(attributesOf(spans[0]!)["langfuse.observation.type"], "span");
  assert.equal(attributesOf(spans[0]!)["langfuse.session.id"], "channel-1");
});

test("PiRuntimeTrace emits agent, turn, and tool spans", async () => {
  const { telemetry, requests } = createTelemetry();
  const trace = new PiRuntimeTrace(createTestLogger(), {
    telemetry,
    sessionKey: "channel-1",
    userId: "owner-1",
  });
  let listener!: AgentSessionEventListener;
  trace.attach({
    sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
    settingsManager: {
      getHttpIdleTimeoutMs: () => 60_000,
      getProviderRetrySettings: () => ({ maxRetries: 3 }),
    },
    model: { provider: "mistral", id: "mistral-large-latest" },
    thinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    subscribe: (next: AgentSessionEventListener) => {
      listener = next;
      return () => undefined;
    },
  } as never);

  const emit = (event: unknown) => listener(event as AgentSessionEvent);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.001 } },
    },
  });
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "discord_send", args: {} });
  emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "discord_send",
    result: {},
    isError: false,
  });
  emit({ type: "turn_end", message: {}, toolResults: [] });
  emit({ type: "agent_settled", aborted: false });
  await telemetry.flush();

  const spans = spansFrom(requests[0]!);
  assert.deepEqual(spans.map((span) => span.name).sort(), [
    "klein.agent",
    "klein.tool",
    "klein.turn",
  ]);
  const turn = spans.find((span) => span.name === "klein.turn")!;
  const turnAttributes = attributesOf(turn);
  assert.deepEqual(JSON.parse(turnAttributes["langfuse.observation.usage_details"] as string), {
    input: 10,
    output: 5,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 2,
  });
  assert.equal(turnAttributes["output.chars"], 5);

  trace.dispose();
});

test("enables tracing from Langfuse credentials unless LANGFUSE_TRACING disables it", async () => {
  assert.equal(createPiTelemetryFromEnv({ env: {}, logger: createTestLogger() }), undefined);
  assert.equal(
    createPiTelemetryFromEnv({
      env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_TRACING: "0" },
      logger: createTestLogger(),
    }),
    undefined,
  );

  const telemetry = createPiTelemetryFromEnv({
    env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" },
    logger: createTestLogger(),
  });
  assert.ok(telemetry);
  await telemetry.shutdown();
});
