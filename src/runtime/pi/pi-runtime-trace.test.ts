import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  type AgentSessionEvent,
  type AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

import { createDiscordSpeakTool } from "@agents/discord/tools/discord-speak";
import { createLogger } from "@app/logger";
import { isRecord, parseJson } from "@shared/type-guards";
import { createTempDir } from "../../testing/temp-dir";
import { createPiAgentFactory } from "./pi-agent-runtime";
import { PiRuntimeTrace } from "./pi-runtime-trace";
import {
  createStubAssistantMessage,
  createStubExtensionContext,
  createStubModel,
  createStubPiTraceSession,
  createStubUsage,
  loadTestExtension,
} from "./pi-test-helpers";

function parseLogEntries(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => {
    const parsed = parseJson(line);
    if (!isRecord(parsed)) {
      throw new Error(`Expected JSON object log line: ${line}`);
    }
    return parsed;
  });
}

function findRequiredEntry(
  entries: readonly Record<string, unknown>[],
  eventName: string,
): Record<string, unknown> {
  const match = entries.find((entry) => entry.event === eventName);
  assert.ok(match, `Expected log entry for event ${eventName}`);
  return match;
}

async function createTrace() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    destination: { write: (line) => void lines.push(line) },
  }).child({ sessionKey: "voice-test" });
  let now = 0;
  let listener: AgentSessionEventListener | undefined;
  let unsubscribed = false;
  const stubModel = createStubModel({ provider: "test-provider", id: "test-model" });
  const trace = new PiRuntimeTrace(logger, { now: () => now });
  const ext = await loadTestExtension(trace.extension);
  trace.attach(
    createStubPiTraceSession({
      sessionManager: {
        getSessionId: () => "session-test",
        getBranch: () => [],
        appendCustomEntry: () => "entry-1",
      },
      settingsManager: SettingsManager.inMemory({
        httpIdleTimeoutMs: 60_000,
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxAgentDelayMs: 5000 },
      }),
      model: stubModel,
      thinkingLevel: "high",
      steeringMode: "one-at-a-time",
      subscribe: (next) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
    }),
  );
  return {
    trace,
    at: (time: number) => {
      now = time;
    },
    emit: (event: AgentSessionEvent) => {
      listener?.(event);
    },
    provider: (type: string, fields: Record<string, unknown> = {}) =>
      ext.handlers.get(type)?.[0]?.(
        { type, ...fields },
        createStubExtensionContext({ model: stubModel }),
      ),
    entries: () => parseLogEntries(lines),
    serialized: () => lines.join(""),
    unsubscribed: () => unsubscribed,
  };
}

test("separates HTTP wait, reasoning progress, and blocking tool time with shared trace IDs", async () => {
  const h = await createTrace();
  const assistantMsg = createStubAssistantMessage({
    provider: "test-provider",
    model: "test-model",
    stopReason: "toolUse",
    usage: createStubUsage({ input: 10, output: 5 }),
    content: [{ type: "text", text: "private response" }],
  });
  h.trace.registerInput("private transcript", "asr-request");
  h.emit({ type: "agent_start" });
  h.emit({ type: "turn_start" });
  h.emit({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "private transcript" }],
      timestamp: 0,
    },
  });
  h.at(5);
  const headers = { authorization: "private credential" };
  assert.equal(await h.provider("before_provider_headers", { headers }), undefined);
  assert.deepEqual(headers, { authorization: "private credential" });
  h.at(10);
  assert.equal(
    await h.provider("before_provider_request", { payload: { secret: "private payload" } }),
    undefined,
  );
  h.at(180_010);
  await h.provider("after_provider_response", { status: 200, headers });
  h.at(180_015);
  await h.provider("provider_stream_event", {
    provider: "test-provider",
    model: "test-model",
    data: "private provider data",
  });
  h.at(180_020);
  h.emit({
    type: "message_update",
    message: assistantMsg,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private reasoning",
      partial: assistantMsg,
    },
  });
  h.at(180_040);
  h.emit({
    type: "message_end",
    message: assistantMsg,
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
    result: { content: [{ type: "text", text: "private result" }], details: {} },
  });

  const entries = h.entries();
  const response = findRequiredEntry(entries, "pi_llm_http_response");
  const delta = findRequiredEntry(entries, "pi_llm_first_delta");
  const completed = findRequiredEntry(entries, "pi_llm_completed");
  const tool = findRequiredEntry(entries, "pi_tool_completed");
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
        timestamp: 0,
      },
    });
  h.emit({ type: "turn_start" });
  consume();
  await h.provider("before_provider_headers");
  await h.provider("before_provider_request");
  h.at(40);
  await h.provider("after_provider_response", { status: 200 });
  h.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
    errorMessage: "private failure body",
  });
  h.at(2_040);
  await h.provider("before_provider_headers");
  await h.provider("before_provider_request");
  h.at(2_080);
  await h.provider("after_provider_response", { status: 200 });
  h.emit({ type: "turn_start" });
  consume();
  const entries = h.entries();
  const consumed = entries.filter((r) => r.event === "pi_input_consumed");
  assert.deepEqual(
    consumed.map((r) => r.inputId),
    ["first-asr", "second-asr"],
  );
  const [consumed0, consumed1] = consumed;
  assert.ok(consumed0 && consumed1);
  assert.notEqual(consumed0.llmCallId, consumed1.llmCallId);
  const responses = entries.filter((r) => r.event === "pi_llm_http_response");
  const [response0, response1] = responses;
  assert.ok(response0 && response1);
  assert.notEqual(response0.providerRequestId, response1.providerRequestId);
  assert.deepEqual(
    responses.map((r) => r.requestWaitMs),
    [40, 40],
  );
  assert.equal(findRequiredEntry(entries, "pi_queue_updated").steeringCount, 2);
  assert.equal(findRequiredEntry(entries, "pi_retry_scheduled").delayMs, 2_000);
  assert.ok(!h.serialized().includes("private"));
  h.trace.dispose();
  assert.ok(h.unsubscribed());
});

test("background cache warming cannot overwrite the active model's provider timings", async () => {
  const h = await createTrace();
  const assistantMsg = createStubAssistantMessage({ stopReason: "stop" });
  h.emit({ type: "agent_start" });
  h.emit({ type: "turn_start" });
  await h.provider("before_provider_headers");
  await h.provider("before_provider_request");
  h.at(100);
  await h.provider("cache_warming_decision", { action: "warm" });
  await h.provider("before_provider_headers");
  await h.provider("before_provider_request");
  h.at(200);
  await h.provider("after_provider_response", { status: 200 });
  await h.provider("provider_stream_event", { data: "warm data" });
  h.emit({
    type: "message_update",
    message: assistantMsg,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "",
      partial: assistantMsg,
    },
  });
  h.emit({ type: "message_end", message: assistantMsg });
  const entries = h.entries();
  assert.equal(entries.filter((r) => r.event === "pi_llm_provider_started").length, 1);
  assert.ok(!entries.some((r) => r.event === "pi_llm_http_response"));
  assert.ok(entries.some((r) => r.event === "pi_provider_timing_ambiguous"));
  const completed = findRequiredEntry(entries, "pi_llm_completed");
  assert.equal(completed.durationMs, 200);
  assert.equal(completed.providerTimingAmbiguous, true);
  assert.equal(completed.providerRequestId, undefined);
  assert.ok(completed.llmCallId);
  assert.ok(entries.some((r) => r.event === "pi_llm_first_delta"));
});

test("real Pi keeps accepting steer while a spoken tool blocks the next model call", async () => {
  await using temp = await createTempDir("klein-voice-trace-");
  const agentDir = temp.path;
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
    characterName: "クライン",
    llm: { provider: model.provider, model: model.id },
    logger,
    modelRuntime,
    sessionMode: "new",
  }).create(
    { systemPrompt: "Reply using discord_speak.", toolNames: ["discord_speak"] },
    () => [
      createDiscordSpeakTool(async () => {
        notifySpeak();
        await playback;
      }),
    ],
    { role: { kind: "conversation" }, sessionKey: "voice-trace-integration" },
  );
  const entries = () => parseLogEntries(lines);
  const processing = runtime.prompt({
    event: {
      id: "first-asr",
      type: "discord.message",
      source: "discord",
      occurredAt: "2026-10-14T09:30:42.123Z",
      content: [{ type: "text", text: "hello" }],
    },
    context: {},
  });
  try {
    await speaking;
    const steer = runtime.steer?.bind(runtime);
    assert.ok(steer);
    await steer({
      event: {
        id: "second-asr",
        type: "discord.message",
        source: "discord",
        occurredAt: "2026-10-14T09:30:42.123Z",
        content: [{ type: "text", text: "more context" }],
      },
      context: {},
    });
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
    const [consumed0, consumed1] = consumed;
    assert.ok(consumed0 && consumed1);
    assert.notEqual(consumed0.llmCallId, consumed1.llmCallId);
    assert.equal(consumed0.runId, consumed1.runId);
    const toolEnd = logs.findIndex((r) => r.event === "pi_tool_completed");
    const secondTurn = logs.findIndex(
      (r) => r.event === "pi_turn_started" && r.llmCallId === consumed1.llmCallId,
    );
    assert.ok(toolEnd >= 0 && secondTurn > toolEnd);
  } finally {
    releaseSpeak();
    await processing;
    runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
