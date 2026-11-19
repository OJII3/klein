import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MarkdownGuildMemoryStore } from "@modules/memory/infrastructure/markdown-guild-memory-store";
import { createTempDir } from "../../testing/temp-dir";
import {
  GUILD_MEMORY_AGENT_SYSTEM_PROMPT,
  PiGuildMemoryAgent,
  type GuildMemoryAgentSessionFactory,
} from "./pi-guild-memory-agent";

test("lets the background agent edit the guild memory files directly", async () => {
  await using temp = await createTempDir("klein-guild-memory-agent-");
  const directory = join(temp.path, "memory");
  const store = new MarkdownGuildMemoryStore(directory);
  await store.write("guild-a", { type: "guild" }, { facts: ["古い事実"], preferences: [] });
  await store.write(
    "guild-a",
    { channelId: "channel-1", type: "channel" },
    {
      facts: [],
      preferences: ["古い好み"],
    },
  );

  let receivedPrompt = "";
  let receivedFiles: readonly string[] = [];
  let disposed = false;
  const sessionFactory: GuildMemoryAgentSessionFactory = async (options) => {
    receivedFiles = options.files;
    assert.equal(options.guildId, "guild-a");
    assert.equal(options.directory, join(directory, "guild-a"));
    return {
      async prompt(text) {
        receivedPrompt = text;
        await writeFile(
          join(options.directory, "MEMORY.md"),
          "# MEMORY.md\n\n## Facts\n\n- 新しい事実\n\n## Preferences\n",
          "utf8",
        );
      },
      dispose() {
        disposed = true;
      },
    };
  };
  const agent = new PiGuildMemoryAgent({ directory, sessionFactory });

  await agent.process(
    "guild-a",
    [
      {
        memory: { facts: ["古い事実"], preferences: [] },
        scope: { type: "guild" },
      },
      {
        memory: { facts: [], preferences: ["古い好み"] },
        scope: { channelId: "channel-1", type: "channel" },
      },
    ],
    [
      {
        channelId: "channel-1",
        content: "さつき:\n新しい事実",
        id: "message-1",
      },
    ],
  );

  assert.deepEqual(receivedFiles, ["MEMORY.md", "channel-1/MEMORY.md"]);
  assert.match(receivedPrompt, /MEMORY\.md \(guild\)/u);
  assert.match(receivedPrompt, /channel-1\/MEMORY\.md \(channel: channel-1\)/u);
  assert.match(receivedPrompt, /message-1/u);
  assert.match(receivedPrompt, /新しい事実/u);
  assert.equal(disposed, true);
  assert.match(await readFile(join(directory, "guild-a", "MEMORY.md"), "utf8"), /新しい事実/u);
  assert.match(GUILD_MEMORY_AGENT_SYSTEM_PROMPT, /read, write, and edit/u);
});

test("restores edited files when the agent fails", async () => {
  await using temp = await createTempDir("klein-guild-memory-agent-");
  const directory = join(temp.path, "memory");
  const store = new MarkdownGuildMemoryStore(directory);
  await store.write("guild-a", { type: "guild" }, { facts: ["元の事実"], preferences: [] });
  const filePath = join(directory, "guild-a", "MEMORY.md");
  const original = await readFile(filePath, "utf8");
  const agent = new PiGuildMemoryAgent({
    directory,
    sessionFactory: async (options) => ({
      async prompt() {
        await writeFile(join(options.directory, "MEMORY.md"), "壊れた内容", "utf8");
        throw new Error("agent failed");
      },
      dispose() {},
    }),
  });

  await assert.rejects(
    agent.process(
      "guild-a",
      [{ memory: { facts: ["元の事実"], preferences: [] }, scope: { type: "guild" } }],
      [],
    ),
    /agent failed/u,
  );
  assert.equal(await readFile(filePath, "utf8"), original);
});

test("creates a sandboxed standalone agent inside the guild directory", async () => {
  await using temp = await createTempDir("klein-guild-memory-agent-");
  const directory = join(temp.path, "memory");
  let receivedToolNames: string[] = [];
  let receivedPrompt = "";
  let disposed = false;
  const agent = new PiGuildMemoryAgent({
    directory,
    sessionId: "guild-memory-test",
    createFactory: (cwd) => ({
      async create(definition, tools, options) {
        assert.equal(cwd, join(directory, "guild-a"));
        assert.equal(definition.systemPrompt, GUILD_MEMORY_AGENT_SYSTEM_PROMPT);
        assert.equal(options.sessionKey, "guild-memory-test:guild-a");
        receivedToolNames = tools.map((tool) => tool.name).toSorted();
        return {
          async prompt(text) {
            receivedPrompt = text;
            return "no change";
          },
          dispose() {
            disposed = true;
          },
        };
      },
    }),
  });

  await agent.process(
    "guild-a",
    [{ memory: { facts: [], preferences: [] }, scope: { type: "guild" } }],
    [],
  );

  assert.deepEqual(receivedToolNames, ["edit", "read", "write"]);
  assert.match(receivedPrompt, /MEMORY\.md \(guild\)/u);
  assert.equal(disposed, true);
});
