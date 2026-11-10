import assert from "node:assert/strict";
import test from "node:test";

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createLogger } from "@app/logger";
import { PiBackgroundRunner } from "./pi-background-runner";
import { resolveConfiguredModel } from "./pi-model-runtime";
import type { PiUsageReporter } from "./pi-usage-reporter";

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

test("records a one-shot completion's usage and session header", async () => {
  const message = assistantMessage();
  let receivedModel: Model<Api> | undefined;
  const receivedOptions: { maxTokens?: number; sessionId?: string }[] = [];
  const recorded: { message: AssistantMessage; sessionId: string }[] = [];
  const runner = new PiBackgroundRunner({
    agentDir: "/tmp/klein-agent",
    logger,
    modelRuntime: {
      async completeSimple(
        model: Model<Api>,
        _context: Context,
        options?: ModelsSimpleStreamOptions,
      ) {
        receivedModel = model;
        receivedOptions.push(options ?? {});
        return message;
      },
    } as unknown as ModelRuntime,
    usageReporter: {
      recordAssistantMessage(sessionId: string, message: AssistantMessage) {
        recorded.push({ message, sessionId });
      },
    } as unknown as PiUsageReporter,
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
