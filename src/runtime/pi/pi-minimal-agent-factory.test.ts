import assert from "node:assert/strict";
import test from "node:test";

import { createPiMinimalAgentFactory } from "./pi-minimal-agent-factory";
import type { PiSession, PiSessionOptions } from "./pi-standalone-session-runner";
import { createStubModel, createStubToolDefinition } from "./pi-test-helpers";

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
  };
  const factory = createPiMinimalAgentFactory({
    runner,
    model: createStubModel(),
    cwd: "/tmp",
  });
  return { factory, created, prompts, disposed };
}

test("creates a standalone agent from the definition and prompts with plain text", async () => {
  const harness = createHarness();
  const tool = createStubToolDefinition({ name: "read" });
  const agent = await harness.factory.create({ systemPrompt: "system" }, [tool], {
    sessionKey: "memory-1",
  });

  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0]?.sessionId, "memory-1");
  assert.equal(harness.created[0]?.systemPrompt, "system");
  assert.deepEqual(harness.created[0]?.toolNames, ["read"]);
  assert.deepEqual(harness.created[0]?.tools, [tool]);

  const output = await agent.prompt("hello");
  assert.equal(output, "result for hello");
  assert.deepEqual(harness.prompts, ["hello"]);

  agent.dispose();
  assert.deepEqual(harness.disposed, ["memory-1"]);
});
