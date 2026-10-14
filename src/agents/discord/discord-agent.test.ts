import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentFactory } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import { DiscordAgent } from "./discord-agent";
import type { AgentEvent } from "../core/agent-event";
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
  occurredAt: "2026-10-14T09:30:42.123Z",
  images: [
    {
      data: "c2VjcmV0",
      filename: "sample.png",
      id: "attachment-123",
      mimeType: "image/png",
    },
  ],
};

test("routes voice replies through discord_speak using the existing runtime prompt", async () => {
  let tools: readonly ToolDefinition[] = [];
  let toolNames: readonly string[] = [];
  const spoken: string[] = [];
  const runtime: AgentRuntime = {
    async prompt(prompt) {
      assert.equal(prompt.id, message.id);
      assert.equal(prompt.type, "discord.message");
      assert.equal(prompt.source, "discord");
      assert.equal(prompt.occurredAt, message.occurredAt);
      assert.deepEqual(prompt.content, [
        { type: "text", text: "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]" },
        { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
      ]);
      const tool = tools.find((tool) => tool.name === "discord_speak");
      assert.ok(tool);
      await tool.execute("tool-call", { text: "LLMの返答" }, undefined, undefined, {} as never);
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(definition, registeredTools) {
      assert.equal(definition.systemPrompt, "voice system prompt");
      tools = registeredTools as readonly ToolDefinition[];
      toolNames = definition.toolNames;
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(
    agentFactory,
    {} as DiscordService,
    "channel-123",
    "voice system prompt",
    {
      speak: async (text, toolCallId) => {
        assert.equal(toolCallId, "tool-call");
        spoken.push(text);
      },
    },
  );

  assert.ok(toolNames.includes("discord_speak"));
  assert.ok(!toolNames.includes("discord_send"));
  assert.ok(!toolNames.includes("discord_voice"));
  assert.ok(!tools.some((tool) => tool.name === "discord_send" || tool.name === "discord_voice"));
  await agent.prompt(message);
  assert.deepEqual(spoken, ["LLMの返答"]);
  agent.dispose();
});

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
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
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

test("adds bot-specific conversation guidance only for bot messages", async () => {
  const prompts: AgentEvent[] = [];
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
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
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
  assert.equal(eventText(prompts[0]), "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]");
  assert.match(eventText(prompts[1]), /latest Discord message was sent by another bot/);
  assert.match(eventText(prompts[1]), /history, experiences, preferences, or personal information/);
  assert.match(eventText(prompts[1]), /self-contained character-driven closing remark/);

  agent.dispose();
});

test("injects the current guild memory into the agent prompt", async () => {
  let receivedPrompt: AgentEvent | undefined;
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
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
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

  assert.match(eventText(receivedPrompt), /<guild-memory>/u);
  assert.match(eventText(receivedPrompt), /毎週土曜日/u);
  assert.match(eventText(receivedPrompt), /読み取った本文/u);
  agent.dispose();
});

test("binds private reads to the owner and refuses other authors or channels", async () => {
  const prompts: AgentEvent[] = [];
  let tools: readonly ToolDefinition[] = [];
  let requester: Parameters<DiscordService["readMessage"]>[1];
  const factory: AgentFactory = {
    async create(_definition, registeredTools, options) {
      assert.equal(options.ownerFeaturesAllowed, true);
      tools = registeredTools as readonly ToolDefinition[];
      return {
        async prompt(prompt) {
          prompts.push(prompt);
        },
        async steer(prompt) {
          prompts.push(prompt);
        },
        dispose() {},
      };
    },
  };
  const service = {
    async readMessage(_locator, trustedRequester) {
      requester = trustedRequester;
      return { ...message, images: [] };
    },
  } as Pick<DiscordService, "readMessage"> as DiscordService;
  const agent = await DiscordAgent.create(factory, service, message.channelId, "system", {
    ownerUserId: message.author.id,
    ownerFeaturesAllowed: true,
  });
  await agent.prompt(message);
  await agent.steer(message);
  assert.ok(prompts.every((event) => !("ownerFeaturesAllowed" in event)));
  const read = tools.find((tool) => tool.name === "discord_read");
  assert.ok(read);
  await read.execute("read", { messageId: message.id }, undefined, undefined, {} as never);
  assert.deepEqual(requester, { userId: message.author.id });
  for (const invalid of [
    { ...message, author: { ...message.author, id: "other" } },
    { ...message, author: { ...message.author, bot: true } },
    { ...message, channelId: "another-channel" },
  ]) {
    assert.throws(() => agent.prompt(invalid), /Only the owner/);
    assert.throws(() => agent.steer(invalid), /Only the owner/);
  }
  assert.equal(prompts.length, 2);
  agent.dispose();
});

function eventText(event: AgentEvent | undefined): string {
  return (
    event?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n") ?? ""
  );
}
