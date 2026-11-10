import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { UserMemory } from "@modules/user-memory/domain/user-memory";
import {
  MarkdownUserMemoryStore,
  renderUserMemory,
} from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { createTempDir } from "../../testing/temp-dir";
import { resolveConfiguredModel } from "./pi-model-runtime";
import {
  PiUserMemoryAgent,
  USER_MEMORY_AGENT_SYSTEM_PROMPT,
  type UserMemoryAgentSessionFactory,
} from "./pi-user-memory-agent";

const userId = "123456789012345678";
const identity = { username: "alice", displayName: "Alice" } as const;

async function createMemory(tempPath: string): Promise<{ directory: string; memory: UserMemory }> {
  const directory = join(tempPath, "memory");
  const store = new MarkdownUserMemoryStore(directory);
  const memory = await store.ensure(userId, identity);
  return { directory, memory };
}

function createAgent(
  directory: string,
  sessionFactory: UserMemoryAgentSessionFactory,
): PiUserMemoryAgent {
  return new PiUserMemoryAgent({
    agentDir: directory,
    directory,
    model: resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash"),
    modelRuntime: {} as unknown as ModelRuntime,
    sessionFactory,
  });
}

test("lets the background agent write the memory file directly", async () => {
  await using temp = await createTempDir("klein-user-memory-agent-");
  const { directory, memory } = await createMemory(temp.path);
  let receivedPrompt = "";
  let disposed = false;
  const updated: UserMemory = {
    ...memory,
    summary: "Bunが好きなユーザー",
    facts: "- favorite: Bun",
  };
  const agent = createAgent(directory, async ({ directory: sessionDirectory, fileName }) => ({
    async prompt(text) {
      receivedPrompt = text;
      await writeFile(join(sessionDirectory, fileName), renderUserMemory(updated), "utf8");
    },
    dispose() {
      disposed = true;
    },
  }));

  const result = await agent.process(userId, memory, [
    {
      id: "message-1",
      channelId: "channel-1",
      channelName: "雑談",
      occurredAt: "2026-11-11T03:00:00.000Z",
      content: "Alice:\nBunが好き",
    },
  ]);

  assert.equal(result?.summary, "Bunが好きなユーザー");
  assert.equal(result?.facts, "- favorite: Bun");
  assert.match(receivedPrompt, /Update the memory file "123456789012345678\.md"/u);
  assert.match(receivedPrompt, /message-1/u);
  assert.match(receivedPrompt, /Bunが好き/u);
  assert.equal(disposed, true);
  assert.match(USER_MEMORY_AGENT_SYSTEM_PROMPT, /read, write, and edit/u);
});

test("returns undefined when the agent leaves the file untouched", async () => {
  await using temp = await createTempDir("klein-user-memory-agent-");
  const { directory, memory } = await createMemory(temp.path);
  const agent = createAgent(directory, async () => ({
    async prompt() {},
    dispose() {},
  }));

  assert.equal(await agent.process(userId, memory, []), undefined);
});

test("restores the previous file when the agent writes invalid markdown", async () => {
  await using temp = await createTempDir("klein-user-memory-agent-");
  const { directory, memory } = await createMemory(temp.path);
  const filePath = join(directory, `${userId}.md`);
  const original = await readFile(filePath, "utf8");
  const agent = createAgent(directory, async ({ directory: sessionDirectory, fileName }) => ({
    async prompt() {
      await writeFile(join(sessionDirectory, fileName), "not a memory file", "utf8");
    },
    dispose() {},
  }));

  await assert.rejects(agent.process(userId, memory, []), /Front matter is missing/u);
  assert.equal(await readFile(filePath, "utf8"), original);
});
