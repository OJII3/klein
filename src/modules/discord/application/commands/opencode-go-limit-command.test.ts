import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeGoLimitCommand } from "./opencode-go-limit-command.js";

test("replies with the monthly usage and reset time", async () => {
  const deferredReplies: Array<{ ephemeral: boolean | undefined }> = [];
  const editedReplies: string[] = [];
  const command = createOpenCodeGoLimitCommand(async () => ({
    resetsAt: new Date("2026-10-01T14:00:00.000Z"),
    status: "ok",
    usedPercentage: 34.5,
  }));

  await command.handler({
    channelId: "channel-123",
    commandName: "limit",
    deferReply: async (options) => {
      deferredReplies.push({ ephemeral: options?.ephemeral });
    },
    editReply: async (content) => {
      editedReplies.push(content);
    },
    guildId: "guild-123",
    reply: async () => undefined,
    user: {
      displayName: "さつき",
      id: "user-123",
      username: "satsuki",
    },
  });

  assert.deepEqual(deferredReplies, [{ ephemeral: true }]);
  assert.equal(editedReplies.length, 1);
  assert.match(
    editedReplies[0] ?? "",
    /^OpenCode Go 月間使用量\n使用率: 34\.5%\nリセット: 2026\/10\/01 23:00 \(JST\)$/,
  );
});
