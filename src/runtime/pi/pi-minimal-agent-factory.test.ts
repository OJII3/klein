import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createPiMinimalAgentFactory } from "./pi-minimal-agent-factory";
import type {
  PiSession,
  PiSessionOptions,
  PiStandaloneSessionRunner,
} from "./pi-standalone-session-runner";

function createHarness() {
  const created: PiSessionOptions[] = [];
  const prompts: string[] = [];
  const disposed: string[] = [];
  const runner = {
    async createSession(options: PiSessionOptions): Promise<PiSession> {
      created.push(options);
      return {
        async prompt(text) {
          prompts.push(text);
          return `result for ${text}`;
        },
        dispose() {
          disposed.push(options.sessionId);
        },
      };
    },
  } as unknown as PiStandaloneSessionRunner;
  const factory = createPiMinimalAgentFactory({
    runner,
    model: {} as never,
    cwd: "/tmp",
  });
  return { factory, created, prompts, disposed };
}

test("creates a standalone session from the agent definition", async () => {
  const harness = createHarness();
  const tool = { name: "read" } as ToolDefinition;
  let capturedRequesterId: (() => string | undefined) | undefined;
  const runtime = await harness.factory.create(
    { systemPrompt: "system" },
    (toolContext) => {
      capturedRequesterId = toolContext.requesterId;
      return [tool];
    },
    {
      role: { kind: "standalone" },
      sessionKey: "memory-1",
    },
  );

  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0]?.sessionId, "memory-1");
  assert.equal(harness.created[0]?.systemPrompt, "system");
  assert.deepEqual(harness.created[0]?.toolNames, ["read"]);
  assert.deepEqual(harness.created[0]?.tools, [tool]);

  await runtime.prompt({
    event: {
      id: "event-1",
      occurredAt: "2026-11-15T00:00:00.000Z",
      type: "standalone.prompt",
      source: "standalone",
      content: [{ type: "text", text: "hello" }],
    },
    context: { requesterId: "user-1" },
  });
  assert.equal(runtime.lastAssistantText?.(), "result for hello");
  assert.deepEqual(harness.prompts, ["hello"]);
  assert.equal(capturedRequesterId?.(), undefined);

  runtime.dispose();
  assert.deepEqual(harness.disposed, ["memory-1"]);
});

test("rejects roles other than standalone", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.factory.create({ systemPrompt: "system" }, () => [], {
      role: { kind: "attached", taskId: "task-1" },
      sessionKey: "task-1",
    }),
    /only creates standalone agents/,
  );
});
