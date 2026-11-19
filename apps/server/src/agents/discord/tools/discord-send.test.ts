import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import type { PromiseGuard } from "../../tools/promise-guard";
import { createDiscordSendTool } from "./discord-send";

test("returns the sent content in the tool result", async () => {
  let sentMessage: { channelId: string; content: string } | undefined;
  const tool = createDiscordSendTool(
    {
      async sendTyping() {},
      async sendMessage(channelId, content) {
        sentMessage = { channelId, content };
      },
    },
    "current-channel",
  );

  const result = await tool.execute(
    "tool-call",
    { content: "送信する本文" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(sentMessage, {
    channelId: "current-channel",
    content: "送信する本文",
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "The message was sent to Discord.\nSent content:\n送信する本文",
    },
  ]);
});

test("records returned Discord message IDs in details", async () => {
  const tool = createDiscordSendTool(
    {
      async sendTyping() {},
      async sendMessage() {
        return ["msg-101", "msg-102"];
      },
    },
    "current-channel",
  );

  const result = await tool.execute(
    "tool-call",
    { content: "分割メッセージ" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(result.details, { messageIds: ["msg-101", "msg-102"] });
});

test("does not send a blocked promise", async () => {
  let sent = false;
  const guard: PromiseGuard = {
    async check() {
      return { action: "block", reason: "no-active-follow-up" };
    },
  };
  const tool = createDiscordSendTool(
    {
      async sendTyping() {},
      async sendMessage() {
        sent = true;
      },
    },
    "current-channel",
    guard,
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      { content: "後で報告します" },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /follow_up_create を先に成功させる/u,
  );
  assert.equal(sent, false);
});
