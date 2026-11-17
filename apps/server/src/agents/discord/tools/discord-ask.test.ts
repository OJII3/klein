import assert from "node:assert/strict";
import test from "node:test";

import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { createDiscordAskTool } from "./discord-ask";

test("posts the question with the triggering user as the answerer", async () => {
  let sent:
    | {
        channelId: string;
        request: {
          question: string;
          options: readonly string[];
          requesterUserId: string;
        };
      }
    | undefined;
  const tool = createDiscordAskTool(
    {
      async sendChoices(channelId, request) {
        sent = { channelId, request };
        return "choice-message-1";
      },
    },
    "current-channel",
    () => "user-123",
  );

  const result = await tool.execute(
    "tool-call",
    { question: "どちらにしますか？", options: ["A", "B"] },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(sent, {
    channelId: "current-channel",
    request: {
      question: "どちらにしますか？",
      options: ["A", "B"],
      requesterUserId: "user-123",
    },
  });
  assert.deepEqual(result.details, { messageId: "choice-message-1" });
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /answer will arrive later/u,
  );
});

test("fails when the turn was not started by a Discord user", async () => {
  const tool = createDiscordAskTool(
    {
      async sendChoices() {
        throw new Error("should not send");
      },
    },
    "current-channel",
    () => undefined,
  );

  await assert.rejects(
    tool.execute(
      "tool-call",
      { question: "どちらにしますか？", options: ["A", "B"] },
      undefined,
      undefined,
      await createStubExtensionToolContext(),
    ),
    /turn started by a Discord user/u,
  );
});
