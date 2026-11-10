import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { DiscordUserDirectory } from "@modules/discord/application/discord-user-directory";
import { MarkdownUserMemoryStore } from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { createTempDir } from "../../testing/temp-dir";
import { createUserMemoryTools } from "./user-memory";

const userId = "123456789012345678";
const username = "alice";

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0] as { type: string; text: string } | undefined;
  return block?.type === "text" ? block.text : "";
}

function findTool(tools: ReturnType<typeof createUserMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  return tool;
}

function createTools(tempPath: string) {
  const store = new MarkdownUserMemoryStore(join(tempPath, "memory"));
  const users = new DiscordUserDirectory(join(tempPath, "discord-users.json"));
  users.remember({
    bot: false,
    displayName: "Alice",
    id: userId,
    username,
  });
  const tools = createUserMemoryTools(store, users);
  return {
    getTool: findTool(tools, "user_memory_get"),
    updateTool: findTool(tools, "user_memory_update"),
  };
}

test("gets and updates user memory through tools", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const { getTool, updateTool } = createTools(temp.path);

  const missing = await getTool.execute(
    "tool-call",
    { discord_id: username } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.match(textOf(missing), /まだありません/u);

  const created = await updateTool.execute(
    "tool-call",
    {
      discord_id: username,
      display_name: "Alice",
      nickname: "A",
      summary: "TypeScriptが好きなユーザー",
      impression: 20,
      facts: "- birthday: 2000-01-02",
      history: "- 2026-01-01: 初めて話した",
      in_common: "- TypeScript",
      strengthening: "- 次は誕生日を祝う",
    } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.match(textOf(created), /更新しました/u);

  const got = await getTool.execute(
    "tool-call",
    { discord_id: "@Alice" } as never,
    undefined,
    undefined,
    {} as never,
  );
  const markdown = textOf(got);
  assert.match(markdown, /^---\ndiscord_id: "alice"/u);
  assert.match(markdown, /display_name: "Alice"/u);
  assert.match(markdown, /nickname: "A"/u);
  assert.match(markdown, /summary: "TypeScriptが好きなユーザー"/u);
  assert.match(markdown, /impression: 20/u);
  assert.match(markdown, /## Facts\n\n- birthday: 2000-01-02/u);
  assert.match(markdown, /## In common\n\n- TypeScript/u);

  await updateTool.execute(
    "tool-call",
    {
      discord_id: username,
      nickname: null,
      impression_delta: 85,
      history: "- 2026-02-01: 二回目に話した",
    } as never,
    undefined,
    undefined,
    {} as never,
  );

  const updated = await getTool.execute(
    "tool-call",
    { discord_id: username } as never,
    undefined,
    undefined,
    {} as never,
  );
  const updatedMarkdown = textOf(updated);
  assert.doesNotMatch(updatedMarkdown, /nickname:/u);
  assert.match(updatedMarkdown, /impression: 100/u);
  assert.match(updatedMarkdown, /## History\n\n- 2026-02-01: 二回目に話した/u);
  assert.match(updatedMarkdown, /## Facts\n\n- birthday: 2000-01-02/u);
});

test("reports unknown users and rejects updates for them", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const { getTool, updateTool } = createTools(temp.path);

  const missing = await getTool.execute(
    "tool-call",
    { discord_id: "unknown" } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.match(textOf(missing), /見つかりません/u);

  await assert.rejects(
    updateTool.execute(
      "tool-call",
      { discord_id: "unknown", display_name: "Unknown" } as never,
      undefined,
      undefined,
      {} as never,
    ),
    /見つかりません/u,
  );
});

test("rejects empty updates and conflicting impression inputs", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const { updateTool } = createTools(temp.path);

  await assert.rejects(
    updateTool.execute(
      "tool-call",
      { discord_id: username } as never,
      undefined,
      undefined,
      {} as never,
    ),
    /1つ以上/u,
  );
  await assert.rejects(
    updateTool.execute(
      "tool-call",
      {
        discord_id: username,
        display_name: "Alice",
        impression: 1,
        impression_delta: 1,
      } as never,
      undefined,
      undefined,
      {} as never,
    ),
    /同時に指定できません/u,
  );
  await assert.rejects(
    updateTool.execute(
      "tool-call",
      { discord_id: username, summary: "要約" } as never,
      undefined,
      undefined,
      {} as never,
    ),
    /display_name/u,
  );
});
