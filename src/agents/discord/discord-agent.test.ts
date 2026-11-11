import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentFactory } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import { DiscordAgent } from "./discord-agent";
import { createDiscordMessageAgentTurn } from "./discord-message-agent-turn";
import { createDiscordAgentTools } from "./discord-tools";
import type { AgentEvent } from "../core/agent-event";
import type { AgentTurn } from "../core/agent-turn";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import type { ReminderTask, ScheduledTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { DiscordImageAnalysis } from "./tools/discord-read";

const silentWatchCheckRunner: WatchCheckRunner = {
  async run() {
    return { output: "", decision: "silent", exitCode: 0, durationMs: 0, state: {} };
  },
};

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

function createToolsFor(
  channelApi: DiscordChannelApi,
  channelId: string,
  options: {
    readonly ownerFeaturesAllowed?: boolean;
    readonly ownerUserId?: string;
    readonly scheduledTaskStore?: ScheduledTaskStore;
    readonly speak?: (text: string, toolCallId?: string) => Promise<void>;
  } = {},
) {
  return (analyzeImage: DiscordImageAnalysis) =>
    createDiscordAgentTools(
      {
        channelApi,
        channelId,
        ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
        ownerUserId: options.ownerUserId,
        scheduledTaskStore: options.scheduledTaskStore,
        speak: options.speak,
        watchCheckRunner: silentWatchCheckRunner,
      },
      analyzeImage,
    );
}

test("routes voice replies through discord_speak using the existing runtime prompt", async () => {
  let tools: readonly ToolDefinition[] = [];
  const spoken: string[] = [];
  const runtime: AgentRuntime = {
    async prompt(turn) {
      const prompt = turn.event;
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
      await tool.execute(
        "tool-call",
        { text: "LLMの返答" } as never,
        undefined,
        undefined,
        {} as never,
      );
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(definition, registeredTools) {
      assert.equal(definition.systemPrompt, "voice system prompt");
      tools = registeredTools as readonly ToolDefinition[];
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "voice system prompt", {
    tools: createToolsFor({} as DiscordChannelApi, "channel-123", {
      speak: async (text, toolCallId) => {
        assert.equal(toolCallId, "tool-call");
        spoken.push(text);
      },
    }),
  });

  assert.ok(tools.some((tool) => tool.name === "discord_speak"));
  assert.ok(!tools.some((tool) => tool.name === "discord_send" || tool.name === "discord_voice"));
  await agent.promptMessage(message);
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
  const channelApi: DiscordChannelApi = {
    async getChannelLocation(channelId) {
      return { channelId };
    },
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
    async readMessage() {
      return message;
    },
  };

  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt", {
    tools: createToolsFor(channelApi, "channel-123"),
  });
  const readTool = tools.find((tool) => tool.name === "discord_read");
  assert.ok(readTool);

  const result = await readTool.execute(
    "tool-call",
    { messageId: "message-456", focus: "エラーの内容" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(analyzedPrompt, {
    text: "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]",
    images: [{ data: "c2VjcmV0", mimeType: "image/png" }],
    focus: "エラーの内容",
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
  const prompts: AgentTurn[] = [];
  const runtime: AgentRuntime = {
    async prompt(turn) {
      prompts.push(turn);
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt");

  await agent.promptMessage(message);
  await agent.promptMessage({
    ...message,
    author: { ...message.author, bot: true },
  });

  assert.equal(prompts.length, 2);
  assert.equal(
    eventText(prompts[0]?.event),
    "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]",
  );
  assert.match(eventText(prompts[1]?.event), /latest Discord message was sent by another bot/);
  assert.match(
    eventText(prompts[1]?.event),
    /history, experiences, preferences, or personal information/,
  );
  assert.match(eventText(prompts[1]?.event), /self-contained character-driven closing remark/);

  agent.dispose();
});

test("passes guild memory as turn context without merging it into the event", async () => {
  let receivedTurn: AgentTurn | undefined;
  const runtime: AgentRuntime = {
    async prompt(turn) {
      receivedTurn = turn;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt");

  await agent.promptMessage(message, { guildMemory: "### 定例会の曜日\n\n毎週土曜日" });

  assert.equal(receivedTurn?.context.guildMemory, "### 定例会の曜日\n\n毎週土曜日");
  assert.doesNotMatch(eventText(receivedTurn?.event), /<guild-memory>/u);
  assert.match(eventText(receivedTurn?.event), /読み取った本文/u);
  agent.dispose();
});

test("does not inject owner memory into a public agent turn", async () => {
  let receivedTurn: AgentTurn | undefined;
  const runtime: AgentRuntime = {
    async prompt(turn) {
      receivedTurn = turn;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, message.channelId, "system prompt");

  await agent.prompt(
    createDiscordMessageAgentTurn(message, { ownerMemory: "private owner memory" }),
  );

  assert.equal(receivedTurn?.context.ownerMemory, undefined);
  assert.doesNotMatch(eventText(receivedTurn?.event), /private owner memory/u);
  agent.dispose();
});

test("binds private reads to the owner and refuses other authors or channels", async () => {
  const prompts: AgentTurn[] = [];
  let tools: readonly ToolDefinition[] = [];
  let requester: Parameters<DiscordChannelApi["readMessage"]>[1];
  const factory: AgentFactory = {
    async create(_definition, registeredTools, options) {
      assert.equal(options.ownerFeaturesAllowed, true);
      tools = registeredTools as readonly ToolDefinition[];
      return {
        async prompt(turn) {
          prompts.push(turn);
        },
        async steer(turn) {
          prompts.push(turn);
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
  } as Pick<DiscordChannelApi, "readMessage"> as DiscordChannelApi;
  const agent = await DiscordAgent.create(factory, message.channelId, "system", {
    ownerUserId: message.author.id,
    ownerFeaturesAllowed: true,
    tools: createToolsFor(service, message.channelId, {
      ownerFeaturesAllowed: true,
      ownerUserId: message.author.id,
    }),
  });
  await agent.promptMessage(message);
  await agent.steerMessage(message);
  assert.ok(prompts.every((turn) => !("ownerFeaturesAllowed" in turn.event)));
  const read = tools.find((tool) => tool.name === "discord_read");
  assert.ok(read);
  await read.execute("read", { messageId: message.id } as never, undefined, undefined, {} as never);
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
  const reminders = new Map<string, ScheduledTask>();
  const store = {
    async create(task: ScheduledTask) {
      reminders.set(task.id, task);
    },
    async listForScope(kind: ScheduledTask["kind"], channelId: string, accessScope: string) {
      return [...reminders.values()].filter(
        (task) =>
          task.kind === kind && task.channelId === channelId && task.accessScope === accessScope,
      );
    },
    async listDue() {
      return [];
    },
    async delete(_kind: ScheduledTask["kind"], channelId: string, accessScope: string, id: string) {
      const task = reminders.get(id);
      if (task?.channelId !== channelId || task.accessScope !== accessScope) return false;
      return reminders.delete(id);
    },
    async update(task: ScheduledTask) {
      reminders.set(task.id, task);
    },
  } as unknown as ScheduledTaskStore;
  async function createTools(
    sessionKey: string,
    channelId: string,
    ownerFeaturesAllowed: boolean,
    ownerUserId?: string,
  ) {
    let tools: readonly ToolDefinition[] = [];
    await DiscordAgent.create(
      {
        async create(_definition, registeredTools) {
          tools = registeredTools as readonly ToolDefinition[];
          return { async prompt() {}, dispose() {} };
        },
      },
      channelId,
      "system",
      {
        sessionKey,
        ownerFeaturesAllowed,
        ownerUserId,
        tools: createToolsFor({} as DiscordChannelApi, channelId, {
          ownerFeaturesAllowed,
          ownerUserId,
          scheduledTaskStore: store,
        }),
      },
    );
    return tools;
  }
  async function execute(tools: readonly ToolDefinition[], name: string, params: unknown) {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool);
    return tool.execute("call", params as never, undefined, undefined, {} as never);
  }
  const original = await createTools("session-old", "channel-a", false, "123");
  const added = await execute(original, "reminder_add", {
    message: "定例会",
    schedule: { type: "after", minutes: 1 },
  });
  const id = (added.details as { id: string }).id;
  const rotated = await createTools("session-new", "channel-a", false, "123");
  assert.equal(
    (
      (await execute(rotated, "reminder_list", {})).details as unknown as {
        reminders: ReminderTask[];
      }
    ).reminders.length,
    1,
  );
  for (const tools of [
    await createTools("session-new", "channel-b", false, "123"),
    await createTools("session-new", "channel-a", true, "123"),
    await createTools("session-new", "channel-a", true, "456"),
  ]) {
    assert.deepEqual(
      (
        (await execute(tools, "reminder_list", {})).details as unknown as {
          reminders: ReminderTask[];
        }
      ).reminders,
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

test("exposes watch tools in every session with the session scope", async () => {
  const created: ScheduledTask[] = [];
  const store = {
    async create(task: ScheduledTask) {
      created.push(task);
    },
    async listForScope() {
      return [];
    },
    async listDue() {
      return [];
    },
    async delete() {
      return false;
    },
    async update() {},
  } as unknown as ScheduledTaskStore;
  const ownerTools = createToolsFor({} as DiscordChannelApi, "channel-a", {
    ownerFeaturesAllowed: true,
    ownerUserId: "123",
    scheduledTaskStore: store,
  })({} as never);
  const publicTools = createToolsFor({} as DiscordChannelApi, "channel-a", {
    ownerFeaturesAllowed: false,
    ownerUserId: "123",
    scheduledTaskStore: store,
  })({} as never);

  assert.ok(ownerTools.some((tool) => tool.name === "watch_add"));
  const publicWatchTool = publicTools.find((tool) => tool.name === "watch_add");
  assert.ok(publicWatchTool);
  await publicWatchTool.execute(
    "call",
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 15 },
      script: "return 1;",
      message: "確認してください。",
    } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(created.at(-1)?.accessScope, "public");
});
