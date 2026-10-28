import assert from "node:assert/strict";
import test from "node:test";

import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentFactory } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import { DiscordAgent } from "./discord-agent";
import { createDiscordMessageAgentTurn } from "./discord-message-agent-turn";
import type { AgentEvent } from "../core/agent-event";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { Reminder } from "@modules/reminders/domain/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
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
  let tools: readonly ToolRegistration[] = [];
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
      await tool.execute({ text: "LLMの返答" }, { callId: "tool-call" } as never, {} as never);
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(definition, registeredTools) {
      assert.equal(definition.systemPrompt, "voice system prompt");
      tools = registeredTools;
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

  assert.ok(tools.some((tool) => tool.name === "discord_speak"));
  assert.ok(!tools.some((tool) => tool.name === "discord_send" || tool.name === "discord_voice"));
  await agent.promptMessage(message);
  assert.deepEqual(spoken, ["LLMの返答"]);
  agent.dispose();
});

test("wires the runtime image analyzer into discord_read", async () => {
  let tools: readonly ToolRegistration[] = [];
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
      tools = registeredTools;
      return runtime;
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
    async getChannelLocation(channelId) {
      return { channelId };
    },
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
    { messageId: "message-456" },
    { callId: "tool-call" } as never,
    {} as never,
  );

  assert.deepEqual(analyzedPrompt, {
    text: "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
  });
  assert.deepEqual(result.output, [
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
    async getChannelLocation(channelId) {
      return { channelId };
    },
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

  await agent.promptMessage(message);
  await agent.promptMessage({
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
    async getChannelLocation(channelId) {
      return { channelId };
    },
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

  await agent.promptMessage(message, { guildMemory: "### 定例会の曜日\n\n毎週土曜日" });

  assert.match(eventText(receivedPrompt), /<guild-memory>/u);
  assert.match(eventText(receivedPrompt), /毎週土曜日/u);
  assert.match(eventText(receivedPrompt), /読み取った本文/u);
  agent.dispose();
});

test("does not inject owner memory into a public agent turn", async () => {
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
  const agent = await DiscordAgent.create(
    agentFactory,
    {} as DiscordService,
    message.channelId,
    "system prompt",
  );

  await agent.prompt(
    createDiscordMessageAgentTurn(message, { ownerMemory: "private owner memory" }),
  );

  assert.doesNotMatch(eventText(receivedPrompt), /private owner memory/u);
  agent.dispose();
});

test("binds private reads to the owner and refuses other authors or channels", async () => {
  const prompts: AgentEvent[] = [];
  let tools: readonly ToolRegistration[] = [];
  let requester: Parameters<DiscordService["readMessage"]>[1];
  const factory: AgentFactory = {
    async create(_definition, registeredTools, options) {
      assert.equal(options.ownerFeaturesAllowed, true);
      tools = registeredTools;
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
  await agent.promptMessage(message);
  await agent.steerMessage(message);
  assert.ok(prompts.every((event) => !("ownerFeaturesAllowed" in event)));
  const read = tools.find((tool) => tool.name === "discord_read");
  assert.ok(read);
  await read.execute({ messageId: message.id }, { callId: "read" } as never, {} as never);
  assert.deepEqual(requester, { userId: message.author.id });
  for (const invalid of [
    { ...message, author: { ...message.author, id: "other" } },
    { ...message, author: { ...message.author, bot: true } },
    { ...message, channelId: "another-channel" },
  ]) {
    assert.throws(() => agent.promptMessage(invalid), /Only the owner/);
    assert.throws(() => agent.steerMessage(invalid), /Only the owner/);
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

test("keeps reminders across session rotation and isolates channel and access scopes", async () => {
  const reminders = new Map<string, Reminder>();
  const store: ReminderStore = {
    async create(reminder) {
      reminders.set(reminder.id, reminder);
    },
    async listForScope(channelId, accessScope) {
      return [...reminders.values()].filter(
        (reminder) => reminder.channelId === channelId && reminder.accessScope === accessScope,
      );
    },
    async listDue() {
      return [];
    },
    async delete(channelId, accessScope, id) {
      const reminder = reminders.get(id);
      if (reminder?.channelId !== channelId || reminder.accessScope !== accessScope) return false;
      return reminders.delete(id);
    },
    async updateDueAt() {},
  };
  async function createTools(
    sessionKey: string,
    channelId: string,
    ownerFeaturesAllowed: boolean,
    ownerUserId?: string,
  ) {
    let tools: readonly ToolRegistration[] = [];
    await DiscordAgent.create(
      {
        async create(_definition, registeredTools) {
          tools = registeredTools;
          return { async prompt() {}, dispose() {} };
        },
      },
      {} as DiscordService,
      channelId,
      "system",
      { sessionKey, ownerFeaturesAllowed, ownerUserId, reminderStore: store },
    );
    return tools;
  }
  async function execute(tools: readonly ToolRegistration[], name: string, params: unknown) {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool);
    return tool.execute(params, { callId: "call" } as never, {} as never);
  }
  const original = await createTools("session-old", "channel-a", false, "123");
  const added = await execute(original, "reminder_add", {
    message: "定例会",
    schedule: { type: "after", minutes: 1 },
  });
  const id = (added.details as { id: string }).id;
  const rotated = await createTools("session-new", "channel-a", false, "123");
  assert.equal(
    ((await execute(rotated, "reminder_list", {})).details as unknown as { reminders: Reminder[] })
      .reminders.length,
    1,
  );
  for (const tools of [
    await createTools("session-new", "channel-b", false, "123"),
    await createTools("session-new", "channel-a", true, "123"),
    await createTools("session-new", "channel-a", true, "456"),
  ]) {
    assert.deepEqual(
      ((await execute(tools, "reminder_list", {})).details as unknown as { reminders: Reminder[] })
        .reminders,
      [],
    );
    assert.equal(
      ((await execute(tools, "reminder_delete", { id })).details as { deleted: boolean }).deleted,
      false,
    );
  }
  assert.equal(
    ((await execute(rotated, "reminder_delete", { id })).details as { deleted: boolean }).deleted,
    true,
  );
  for (const [allowed, userId, expectedScope] of [
    [true, "123", "owner:123"],
    [true, undefined, "public"],
    [false, "123", "public"],
  ] as const) {
    const tools = await createTools("session-any", "channel-a", allowed, userId);
    const result = await execute(tools, "reminder_add", {
      message: "通知",
      schedule: { type: "after", minutes: 1 },
    });
    assert.equal(reminders.get((result.details as { id: string }).id)?.accessScope, expectedScope);
  }
});
