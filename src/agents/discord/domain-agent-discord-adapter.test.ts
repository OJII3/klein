import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordService } from "@modules/discord/ports/discord-service";
import {
  createDomainAgentDiscordAdapter,
  splitDiscordMessage,
} from "./domain-agent-discord-adapter";

test("Discord output sink trims, suppresses NO_ACTION, and sends chunks", async () => {
  const sentMessages: Array<{ channelId: string; text: string }> = [];
  const discordService = {
    async sendMessage(channelId: string, text: string) {
      sentMessages.push({ channelId, text });
    },
  } as unknown as DiscordService;
  const adapter = createDomainAgentDiscordAdapter(discordService, "calendar-channel", "owner");

  await adapter.outputSink.writeAssistantText("  NO_ACTION  ");
  await adapter.outputSink.writeAssistantText(`  ${"x".repeat(4_001)}  `);

  assert.deepEqual(sentMessages, [
    { channelId: "calendar-channel", text: "x".repeat(2_000) },
    { channelId: "calendar-channel", text: "x".repeat(2_000) },
    { channelId: "calendar-channel", text: "x" },
  ]);
});

test("splitDiscordMessage prefers newline boundaries", () => {
  assert.deepEqual(splitDiscordMessage("first\nsecond\nthird", 9), ["first", "second", "third"]);
});
