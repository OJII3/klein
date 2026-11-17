import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { DiscordUserDirectory } from "@modules/discord/application/discord-user-directory";
import { FileDiscordUserStore } from "@modules/discord/infrastructure/file-discord-user-store";
import { MarkdownUserMemoryStore } from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { isRecord } from "@shared/type-guards";
import { createTempDir } from "../../testing/temp-dir";
import { createUserMemoryTools } from "./user-memory";

const userId = "123456789012345678";
const username = "alice";

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

function findTool(tools: ReturnType<typeof createUserMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  return tool;
}

function createTools(tempPath: string) {
  const store = new MarkdownUserMemoryStore(join(tempPath, "memory"));
  const users = new DiscordUserDirectory(
    new FileDiscordUserStore(join(tempPath, "discord-users.json")),
  );
  users.remember({
    bot: false,
    displayName: "Alice",
    id: userId,
    username,
  });
  const tools = createUserMemoryTools(store, users);
  return {
    getTool: findTool(tools, "user_memory_get"),
    store,
    toolNames: tools.map((tool) => tool.name),
  };
}

test("gets user memory through the read-only tool", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const { getTool, store, toolNames } = createTools(temp.path);
  const ctx = await createStubExtensionToolContext();

  assert.deepEqual(toolNames, ["user_memory_get"]);

  const missing = await getTool.execute(
    "tool-call",
    { discord_id: username },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(missing), /まだありません/u);

  await store.update(
    userId,
    { username, displayName: "Alice" },
    {
      nickname: "A",
      summary: "TypeScriptが好きなユーザー",
      impression: 20,
      facts: "- birthday: 2000-01-02",
      history: "- 2026-01-01: 初めて話した",
      inCommon: "- TypeScript",
      strengthening: "- 次は誕生日を祝う",
    },
  );

  const got = await getTool.execute(
    "tool-call",
    { discord_id: "@Alice" },
    undefined,
    undefined,
    ctx,
  );
  const markdown = textOf(got);
  assert.match(markdown, /^---\ndiscord_id: "alice"/u);
  assert.match(markdown, /display_name: "Alice"/u);
  assert.match(markdown, /nickname: "A"/u);
  assert.match(markdown, /summary: "TypeScriptが好きなユーザー"/u);
  assert.match(markdown, /impression: 20/u);
  assert.match(markdown, /## Facts\n\n- birthday: 2000-01-02/u);
  assert.match(markdown, /## In common\n\n- TypeScript/u);
});

test("reports unknown users", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const { getTool } = createTools(temp.path);

  const missing = await getTool.execute(
    "tool-call",
    { discord_id: "unknown" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
  assert.match(textOf(missing), /見つかりません/u);
});
