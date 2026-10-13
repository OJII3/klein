import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@app/logger";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import { createPiAgentFactory } from "./pi-agent-runtime";
import { createDiscordSpeakTool } from "@agents/discord/tools/discord-speak";

async function createTrace() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    destination: { write: (line) => void lines.push(line) },
  }).child({ sessionKey: "voice-test" });
  let now = 0;
  let listener!: AgentSessionEventListener;
  let unsubscribed = false;
  const trace = new PiRuntimeTrace(logger, () => now);
  const handlers = new Map<string, (event: never, context: ExtensionContext) => unknown>();
  await trace.extension({
    on: (event: string, handler: (event: never, context: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI);
  trace.attach({
    sessionManager: { getSessionId: () => "session-test", getBranch: () => [] },
    settingsManager: {
      getHttpIdleTimeoutMs: () => 60_000,
      getProviderRetrySettings: () => ({ maxRetries: 3 }),
    },
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "high",
    steeringMode: "one-at-a-time",
    subscribe: (next: AgentSessionEventListener) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
  } as never);
  return {
    trace,
    at: (time: number) => {
      now = time;
    },
    emit: (event: unknown) => listener(event as AgentSessionEvent),
    provider: (type: string, fields: Record<string, unknown> = {}) =>
      handlers.get(type)?.(
        { type, ...fields } as never,
        {
          model: { provider: "test-provider", id: "test-model" },
        } as ExtensionContext,
      ),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    serialized: () => lines.join(""),
    unsubscribed: () => unsubscribed,
  };
}

test("separates HTTP wait, reasoning progress, and blocking tool time with shared trace IDs", async () => {
  const h = await createTrace();
  h.trace.registerInput("private transcript", "asr-request");
  h.emit({ type: "agent_start" });
  h.emit({ type: "turn_start" });
  h.emit({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "private transcript" }],
    },
  });
  h.at(5);
  const headers = { authorization: "private credential" };
  assert.equal(h.provider("before_provider_headers", { headers }), undefined);
  assert.deepEqual(headers, { authorization: "private credential" });
  h.at(10);
  assert.equal(
    h.provider("before_provider_request", { payload: { secret: "private payload" } }),
    undefined,
  );
  h.at(180_010);
  h.provider("after_provider_response", { status: 200, headers });
  h.at(180_015);
  h.provider("provider_stream_event", {
    provider: "test-provider",
    model: "test-model",
    data: "private provider data",
  });
  h.at(180_020);
  h.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: "private reasoning",
    },
  });
  h.at(180_040);
  h.emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      stopReason: "toolUse",
      usage: { input: 10, output: 5 },
      content: [{ type: "text", text: "private response" }],
    },
  });
  h.at(180_045);
  h.emit({
    type: "tool_execution_start",
    toolCallId: "speak-call",
    toolName: "discord_speak",
    args: { text: "private spoken text" },
  });
  h.at(180_545);
  h.emit({
    type: "tool_execution_end",
    toolCallId: "speak-call",
    toolName: "discord_speak",
    isError: false,
    result: { content: "private result" },
  });

  const entries = h.entries();
  const response = entries.find((r) => r.event === "pi_llm_http_response")!;
  const delta = entries.find((r) => r.event === "pi_llm_first_delta")!;
  const completed = entries.find((r) => r.event === "pi_llm_completed")!;
  const tool = entries.find((r) => r.event === "pi_tool_completed")!;
  assert.equal(response.requestWaitMs, 180_000);
  assert.equal(response.providerElapsedMs, 180_005);
  assert.equal(delta.kind, "thinking_delta");
  assert.equal(delta.turnElapsedMs, 180_020);
  assert.equal(completed.durationMs, 180_040);
  assert.equal(tool.durationMs, 500);
  assert.equal(tool.toolCallId, "speak-call");
  for (const entry of [response, delta, completed, tool]) {
    assert.equal(entry.sessionKey, "voice-test");
    assert.equal(entry.sessionId, "session-test");
    assert.equal(entry.inputId, "asr-request");
    assert.equal(entry.runId, response.runId);
    assert.equal(entry.llmCallId, response.llmCallId);
    assert.equal(entry.providerRequestId, response.providerRequestId);
  }
  assert.ok(response.llmCallId);
  assert.ok(entries.some((r) => r.event === "pi_llm_progress"));
  assert.ok(!h.serialized().includes("private"));
});

test("tracks repeated steering inputs and provider dispatches without leaking queue contents", async () => {
  const h = await createTrace();
  h.trace.registerInput("same private input", "first-asr");
  h.trace.registerInput("same private input", "second-asr");
  h.emit({ type: "agent_start" });
  h.emit({
    type: "queue_update",
    steering: ["same private input", "same private input"],
    followUp: [],
  });
  const consume = () =>
    h.emit({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "same private input" }],
      },
    });
  h.emit({ type: "turn_start" });
  consume();
  h.provider("before_provider_headers");
  h.provider("before_provider_request");
  h.at(40);
  h.provider("after_provider_response", { status: 200 });
  h.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
    errorMessage: "private failure body",
  });
  h.at(2_040);
  h.provider("before_provider_headers");
  h.provider("before_provider_request");
  h.at(2_080);
  h.provider("after_provider_response", { status: 200 });
  h.emit({ type: "turn_start" });
  consume();
  const entries = h.entries();
  const consumed = entries.filter((r) => r.event === "pi_input_consumed");
  assert.deepEqual(
    consumed.map((r) => r.inputId),
    ["first-asr", "second-asr"],
  );
  assert.notEqual(consumed[0]!.llmCallId, consumed[1]!.llmCallId);
  const responses = entries.filter((r) => r.event === "pi_llm_http_response");
  assert.notEqual(responses[0]!.providerRequestId, responses[1]!.providerRequestId);
  assert.deepEqual(
    responses.map((r) => r.requestWaitMs),
    [40, 40],
  );
  assert.equal(entries.find((r) => r.event === "pi_queue_updated")!.steeringCount, 2);
  assert.equal(entries.find((r) => r.event === "pi_retry_scheduled")!.delayMs, 2_000);
  assert.ok(!h.serialized().includes("private"));
  h.trace.dispose();
  assert.ok(h.unsubscribed());
});

test("background cache warming cannot overwrite the active model's provider timings", async () => {
  const h = await createTrace();
  h.emit({ type: "agent_start" });
  h.emit({ type: "turn_start" });
  h.provider("before_provider_headers");
  h.provider("before_provider_request");
  h.at(100);
  h.provider("cache_warming_decision", { action: "warm" });
  h.provider("before_provider_headers");
  h.provider("before_provider_request");
  h.at(200);
  h.provider("after_provider_response", { status: 200 });
  h.provider("provider_stream_event", { data: "warm data" });
  h.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
  h.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  const entries = h.entries();
  assert.equal(entries.filter((r) => r.event === "pi_llm_provider_started").length, 1);
  assert.ok(!entries.some((r) => r.event === "pi_llm_http_response"));
  assert.ok(entries.some((r) => r.event === "pi_provider_timing_ambiguous"));
  const completed = entries.find((r) => r.event === "pi_llm_completed")!;
  assert.equal(completed.durationMs, 200);
  assert.equal(completed.providerTimingAmbiguous, true);
  assert.equal(completed.providerRequestId, undefined);
  assert.ok(completed.llmCallId);
  assert.ok(entries.some((r) => r.event === "pi_llm_first_delta"));
});

test("real Pi keeps accepting steer while a spoken tool blocks the next model call", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-voice-trace-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const lines: string[] = [];
  const logger = createLogger({ destination: { write: (line) => void lines.push(line) } });
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  let modelCalls = 0;
  provider.setResponses([
    () => {
      modelCalls += 1;
      return fauxAssistantMessage(fauxToolCall("discord_speak", { text: "reply" }));
    },
    () => {
      modelCalls += 1;
      return fauxAssistantMessage("done");
    },
  ]);
  let releaseSpeak!: () => void;
  let notifySpeak!: () => void;
  const speaking = new Promise<void>((resolve) => {
    notifySpeak = resolve;
  });
  const playback = new Promise<void>((resolve) => {
    releaseSpeak = resolve;
  });
  const runtime = await createPiAgentFactory({
    agentDir,
    llm: { provider: model.provider, model: model.id },
    logger,
    modelRuntime,
    sessionMode: "new",
  }).create(
    { systemPrompt: "Reply using discord_speak.", toolNames: ["discord_speak"] },
    [
      createDiscordSpeakTool(async () => {
        notifySpeak();
        await playback;
      }),
    ],
    { sessionKey: "voice-trace-integration" },
  );
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const processing = runtime.prompt({ traceId: "first-asr", text: "hello", images: [] });
  try {
    await speaking;
    assert.ok(runtime.steer);
    await runtime.steer({ traceId: "second-asr", text: "more context", images: [] });
    assert.equal(modelCalls, 1);
    assert.ok(entries().some((r) => r.event === "pi_queue_updated" && r.steeringCount === 1));
    assert.ok(!entries().some((r) => r.event === "pi_tool_completed"));
    releaseSpeak();
    await processing;
    assert.equal(modelCalls, 2);
    const logs = entries();
    const consumed = logs.filter((r) => r.event === "pi_input_consumed");
    assert.deepEqual(
      consumed.map((r) => r.inputId),
      ["first-asr", "second-asr"],
    );
    assert.notEqual(consumed[0]!.llmCallId, consumed[1]!.llmCallId);
    assert.equal(consumed[0]!.runId, consumed[1]!.runId);
    const toolEnd = logs.findIndex((r) => r.event === "pi_tool_completed");
    const secondTurn = logs.findIndex(
      (r) => r.event === "pi_turn_started" && r.llmCallId === consumed[1]!.llmCallId,
    );
    assert.ok(toolEnd >= 0 && secondTurn > toolEnd);
  } finally {
    releaseSpeak();
    await processing;
    runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
