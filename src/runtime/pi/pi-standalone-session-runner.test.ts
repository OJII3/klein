import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { createLogger } from "@app/logger";
import { PiStandaloneSessionRunner, standaloneSessionDir } from "./pi-standalone-session-runner";
import { resolveConfiguredModel } from "./pi-model-runtime";
import { createStubToolDefinition, createTestModelRuntime } from "./pi-test-helpers";

const logger = createLogger({ level: "silent" });

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    content: [{ type: "text", text: "ok" }],
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    responseId: "response-1",
    stopReason: "stop",
    timestamp: 1_794_000_000_000,
    usage: {
      input: 10,
      output: 2,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("stores standalone sessions under the agent directory", () => {
  assert.equal(
    standaloneSessionDir("/tmp/klein-agent", "user-memory:1"),
    resolve("/tmp/klein-agent/sessions/standalone/user-memory%3A1"),
  );
});

test("standalone sessions reject surface tools", async () => {
  const runner = new PiStandaloneSessionRunner({
    agentDir: "/tmp/klein-agent",
    logger,
    modelRuntime: await createTestModelRuntime(),
  });

  await assert.rejects(
    runner.createSession({
      cwd: "/tmp",
      model: resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash"),
      sessionId: "user-memory-1",
      systemPrompt: "system",
      toolNames: [],
      tools: [{ ...createStubToolDefinition({ name: "discord_send" }), surface: true }],
    }),
    /standalone agent role may not use the surface tool discord_send/,
  );
});

test("records a one-shot completion's usage and session header", async () => {
  const message = assistantMessage();
  let receivedModel: Model<Api> | undefined;
  const receivedOptions: { maxTokens?: number; sessionId?: string }[] = [];
  const recorded: { message: AssistantMessage; sessionId: string }[] = [];
  const modelRuntime = await createTestModelRuntime();
  modelRuntime.completeSimple = async (
    model: Model<Api>,
    _context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => {
    receivedModel = model;
    receivedOptions.push(options ?? {});
    return message;
  };
  const runner = new PiStandaloneSessionRunner({
    agentDir: "/tmp/klein-agent",
    logger,
    modelRuntime,
    usageReporter: {
      recordAssistantMessage(sessionId: string, recordedMessage: AssistantMessage) {
        recorded.push({ message: recordedMessage, sessionId });
      },
    },
  });

  const response = await runner.createCompleter("memory-session")(
    resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash"),
    { messages: [], systemPrompt: "system" },
    { maxTokens: 100 },
  );

  assert.equal(response, message);
  assert.equal(receivedModel?.headers?.["x-opencode-session"], "memory-session");
  assert.equal(receivedOptions[0]?.maxTokens, 100);
  assert.equal(receivedOptions[0]?.sessionId, "memory-session");
  assert.deepEqual(recorded, [{ message, sessionId: "memory-session" }]);
});
