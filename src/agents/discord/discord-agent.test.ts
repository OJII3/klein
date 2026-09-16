import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentFactory } from "../core/agent-factory";
import type { AgentPrompt, AgentRuntime } from "../core/agent-runtime";
import { DiscordAgent } from "./discord-agent";
import { createCodexTools } from "./tools/codex-delegate";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";

const message: DiscordMessage = {
  author: {
    bot: false,
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
    setActivity() {},
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

test("exposes codex_delegate only when configured", async () => {
  let definition: { toolNames: readonly string[] } | undefined;
  const runtime: AgentRuntime = {
    async prompt() {},
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(agentDefinition) {
      definition = agentDefinition;
      return runtime;
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
    async sendMessage() {},
    async readMessage() {
      return message;
    },
    async stop() {},
  };

  const codexTools = createCodexTools({
    defaultWorkspace: "/workspace/klein",
    discordService,
    channelId: "channel-123",
    socketPath: "/tmp/codex.sock",
    taskScheduler: { run: async (task) => task() },
  });
  const agent = await DiscordAgent.create(
    agentFactory,
    discordService,
    "channel-123",
    "system prompt",
    codexTools,
  );

  assert.ok(definition?.toolNames.includes("codex_delegate"));
  assert.ok(definition?.toolNames.includes("codex_projects"));
  assert.ok(definition?.toolNames.includes("codex_task_status"));
  agent.dispose();
});

test("adds bot-specific conversation guidance only for bot messages", async () => {
  const prompts: AgentPrompt[] = [];
  const runtime: AgentRuntime = {
    async prompt(prompt) {
      prompts.push(prompt);
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
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

  await agent.prompt(message);
  await agent.prompt({
    ...message,
    author: { ...message.author, bot: true },
  });

  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]?.text, "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]");
  assert.match(prompts[1]?.text ?? "", /latest Discord message was sent by another bot/);
  assert.match(
    prompts[1]?.text ?? "",
    /history, experiences, preferences, or personal information/,
  );
  assert.match(prompts[1]?.text ?? "", /self-contained character-driven closing remark/);

  agent.dispose();
});

test("injects the current guild memory into the agent prompt", async () => {
  let receivedPrompt: AgentPrompt | undefined;
  const runtime: AgentRuntime = {
    async prompt(prompt) {
      receivedPrompt = prompt;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
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

  await agent.prompt(message, "### 定例会の曜日\n\n毎週土曜日");

  assert.match(receivedPrompt?.text ?? "", /<guild-memory>/u);
  assert.match(receivedPrompt?.text ?? "", /毎週土曜日/u);
  assert.match(receivedPrompt?.text ?? "", /読み取った本文/u);
  agent.dispose();
});
