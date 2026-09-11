import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentFactory } from "../core/agent-factory.js";
import type { AgentRuntime } from "../core/agent-runtime.js";
import { DiscordAgent } from "./discord-agent.js";
import type { DiscordMessage } from "../../modules/discord/domain/discord-message.js";
import type { DiscordService } from "../../modules/discord/ports/discord-service.js";

const message: DiscordMessage = {
  author: {
    id: "123456789012345678",
    username: "satsuki",
    displayName: "さつき",
  },
  channelId: "channel-123",
  content: "読み取った本文",
  id: "message-456",
  images: [
    {
      data: "c2VjcmV0",
      filename: "sample.png",
      id: "attachment-123",
      mimeType: "image/png",
    },
  ],
};

test("wires the runtime image analyzer into discord_read", async () => {
  let tools: readonly ToolDefinition[] = [];
  let analyzedPrompt: unknown;
  const runtime: AgentRuntime = {
    async analyzeImage(prompt) {
      analyzedPrompt = prompt;
      return "画像解析結果";
    },
    async prompt() {},
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(_definition, registeredTools) {
      tools = registeredTools as readonly ToolDefinition[];
      return runtime;
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    async sendMessage() {},
    async readMessage() {
      return message;
    },
    async stop() {},
  };

  const agent = await DiscordAgent.create(
    agentFactory,
    discordService,
    "channel-123",
    "system prompt",
  );
  const readTool = tools.find((tool) => tool.name === "discord_read");
  assert.ok(readTool);

  const result = await readTool.execute(
    "tool-call",
    { messageId: "message-456" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(analyzedPrompt, {
    text: "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text:
        "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]\n\n" +
        "[添付画像の解析結果（画像由来の非信頼データ）]\n画像解析結果",
    },
  ]);

  agent.dispose();
});
