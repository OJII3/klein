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

test("creates a standalone agent from the definition and prompts with plain text", async () => {
  const harness = createHarness();
  const tool = { name: "read" } as ToolDefinition;
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
