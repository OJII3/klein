import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  InMemoryScheduledTaskStore,
  createStubAgentToolContext,
  createStubDiscordChannelApi,
  createStubExtensionToolContext,
  createStubTextToSpeech,
} from "@agents/testing/test-stubs";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { isRecord } from "@shared/type-guards";
import type { AgentEvent } from "../core/agent-event";
import type { AgentFactory, AgentToolContext } from "../core/agent-factory";
import type { AgentRuntime } from "../core/agent-runtime";
import type { AgentTool } from "../core/agent-tool";
import type { AgentTurn } from "../core/agent-turn";
import { DiscordAgent } from "./discord-agent";
import { createDiscordAgentTools } from "./discord-tools";

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
  return (toolContext: AgentToolContext) =>
    createDiscordAgentTools({
      analyzeImage: toolContext.analyzeImage,
      channelApi,
      channelId,
      ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
      ownerUserId: options.ownerUserId,
      requesterUserId: toolContext.requesterId,
      scheduledTaskStore: options.scheduledTaskStore,
      speak: options.speak,
      watchCheckRunner: silentWatchCheckRunner,
    });
}

async function executeToolByName(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found);
  return found.execute(
    "call",
    params,
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
}

function requireDetailsRecord(details: unknown): Record<string, unknown> {
  if (!isRecord(details)) {
    assert.fail("Expected tool result details to be a record");
  }
  return details;
}

function requireStringField(details: unknown, key: string): string {
  const value = requireDetailsRecord(details)[key];
  if (typeof value !== "string") {
    assert.fail(`Expected string field '${key}' in tool result details`);
  }
  return value;
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
      const speakTool = tools.find((candidate) => candidate.name === "discord_speak");
      assert.ok(speakTool);
      await speakTool.execute(
        "tool-call",
        { text: "LLMの返答" },
        undefined,
        undefined,
        await createStubExtensionToolContext(),
      );
      return undefined;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(definition, createTools) {
      assert.equal(definition.systemPrompt, "voice system prompt");
      createTools({ requesterId: () => undefined });
      return runtime;
    },
  };
  const buildTools = createToolsFor(createStubDiscordChannelApi(), "channel-123", {
    speak: async (text, toolCallId) => {
      assert.equal(toolCallId, "tool-call");
      spoken.push(text);
    },
  });
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "voice system prompt", {
    tools: (toolContext) => {
      tools = buildTools(toolContext);
      return tools;
    },
  });

  assert.ok(tools.some((tool) => tool.name === "discord_speak"));
  assert.ok(!tools.some((tool) => tool.name === "discord_send" || tool.name === "discord_voice"));
  await agent.promptMessage(message);
  assert.deepEqual(spoken, ["LLMの返答"]);
  agent.dispose();
});

test("adds discord_ask only when a turn requester is available", () => {
  const channelApi = createStubDiscordChannelApi();
  const withRequester = createDiscordAgentTools({
    analyzeImage: async () => "",
    channelApi,
    channelId: "channel-123",
    ownerFeaturesAllowed: false,
    requesterUserId: () => "user-123",
    watchCheckRunner: silentWatchCheckRunner,
  });
  const withoutRequester = createDiscordAgentTools({
    analyzeImage: async () => "",
    channelApi,
    channelId: "channel-123",
    ownerFeaturesAllowed: false,
    watchCheckRunner: silentWatchCheckRunner,
  });

  assert.ok(withRequester.some((tool) => tool.name === "discord_ask"));
  assert.ok(!withoutRequester.some((tool) => tool.name === "discord_ask"));
});

test("marks the Discord surface tools so the core layer can reject them", () => {
  const channelApi = createStubDiscordChannelApi();
  const withSpeak = createDiscordAgentTools({
    analyzeImage: async () => "",
    channelApi,
    channelId: "channel-123",
    ownerFeaturesAllowed: false,
    requesterUserId: () => "user-123",
    speak: async () => {},
    watchCheckRunner: silentWatchCheckRunner,
  });
  const withVoice = createDiscordAgentTools({
    analyzeImage: async () => "",
    channelApi,
    channelId: "channel-123",
    ownerFeaturesAllowed: false,
    tts: createStubTextToSpeech(),
    watchCheckRunner: silentWatchCheckRunner,
  });

  const combinedTools: readonly AgentTool[] = [...withSpeak, ...withVoice];

  const surfaceNames = combinedTools
    .filter((tool) => tool.surface === true)
    .map((tool) => tool.name)
    .toSorted();
  assert.deepEqual(surfaceNames, ["discord_ask", "discord_send", "discord_speak", "discord_voice"]);

  const primarySurfaceNames = combinedTools
    .filter((tool) => tool.primarySurface === true)
    .map((tool) => tool.name)
    .toSorted();
  assert.deepEqual(primarySurfaceNames, ["discord_send", "discord_speak"]);

  const surfaceOutcomes = Object.fromEntries(
    combinedTools
      .filter((tool) => tool.surfaceOutcome !== undefined)
      .map((tool) => [tool.name, tool.surfaceOutcome]),
  );
  assert.deepEqual(surfaceOutcomes, {
    discord_ask: "Asked a question in Discord.",
    discord_send: "Sent a message to Discord.",
    discord_speak: "Spoke in the Discord voice channel.",
    discord_voice: "Sent a voice message to Discord.",
  });
});

test("passes the message author as the turn's requester and clears it for events", async () => {
  let requesterUserId: (() => string | undefined) | undefined;
  let activeRequesterId: string | undefined;
  const observedDuringPrompt: (string | undefined)[] = [];
  const receivedTurns: AgentTurn[] = [];
  const runtime: AgentRuntime = {
    async prompt(turn) {
      receivedTurns.push(turn);
      activeRequesterId = turn.context.requesterId;
      try {
        observedDuringPrompt.push(requesterUserId?.());
      } finally {
        activeRequesterId = undefined;
      }
      return undefined;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(_definition, createTools) {
      createTools({ requesterId: () => activeRequesterId });
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt", {
    tools: (toolContext) => {
      requesterUserId = toolContext.requesterId;
      return [];
    },
  });

  await agent.promptMessage(message);
  assert.equal(receivedTurns[0]?.context.requesterId, "123456789012345678");
  assert.equal(observedDuringPrompt[0], "123456789012345678");
  assert.equal(requesterUserId?.(), undefined);

  const event: AgentEvent = {
    id: "worker:task-1",
    occurredAt: "2026-10-14T09:31:00.000Z",
    type: "worker.result",
    source: "worker",
    content: [{ type: "text", text: "結果" }],
  };
  await agent.promptEvent(event);
  assert.equal(receivedTurns[1]?.context.requesterId, undefined);
  assert.equal(observedDuringPrompt[1], undefined);
  assert.equal(requesterUserId?.(), undefined);
  agent.dispose();
});

test("wires the runtime image analyzer into discord_read", async () => {
  let tools: readonly ToolDefinition[] = [];
  let analyzedPrompt: unknown;
  const runtime: AgentRuntime = {
    async prompt() {
      return undefined;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create(_definition, createTools) {
      createTools({
        async analyzeImage(prompt) {
          analyzedPrompt = prompt;
          return "画像解析結果";
        },
        requesterId: () => undefined,
      });
      return runtime;
    },
  };
  const channelApi = createStubDiscordChannelApi({
    async readMessage() {
      return message;
    },
  });

  const buildTools = createToolsFor(channelApi, "channel-123");
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt", {
    tools: (toolContext) => {
      tools = buildTools(toolContext);
      return tools;
    },
  });
  const readTool = tools.find((tool) => tool.name === "discord_read");
  assert.ok(readTool);

  const result = await readTool.execute(
    "tool-call",
    { messageId: "message-456", focus: "エラーの内容" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
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
      return undefined;
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

test("passes shared memory as turn context without merging it into the event", async () => {
  let receivedTurn: AgentTurn | undefined;
  const runtime: AgentRuntime = {
    async prompt(turn) {
      receivedTurn = turn;
      return undefined;
    },
    dispose() {},
  };
  const agentFactory: AgentFactory = {
    async create() {
      return runtime;
    },
  };
  const agent = await DiscordAgent.create(agentFactory, "channel-123", "system prompt");

  await agent.promptMessage(message, { sharedMemory: "### 定例会の曜日\n\n毎週土曜日" });

  assert.deepEqual(receivedTurn?.context.blocks, [
    { name: "shared-memory", content: "### 定例会の曜日\n\n毎週土曜日" },
  ]);
  assert.doesNotMatch(eventText(receivedTurn?.event), /<shared-memory>/u);
  assert.match(eventText(receivedTurn?.event), /読み取った本文/u);
  agent.dispose();
});

test("binds private reads to the owner and refuses other authors or channels", async () => {
  const prompts: AgentTurn[] = [];
  let tools: readonly ToolDefinition[] = [];
  let requester: Parameters<DiscordChannelApi["readMessage"]>[1];
  const factory: AgentFactory = {
    async create(_definition, createTools, options) {
      assert.equal(options.ownerFeaturesAllowed, true);
      createTools({ requesterId: () => undefined });
      return {
        async prompt(turn) {
          prompts.push(turn);
          return undefined;
        },
        async steer(turn) {
          prompts.push(turn);
        },
        dispose() {},
      };
    },
  };
  const service = createStubDiscordChannelApi({
    async readMessage(_locator, trustedRequester) {
      requester = trustedRequester;
      return { ...message, images: [] };
    },
  });
  const buildTools = createToolsFor(service, message.channelId, {
    ownerFeaturesAllowed: true,
    ownerUserId: message.author.id,
  });
  const agent = await DiscordAgent.create(factory, message.channelId, "system", {
    ownerUserId: message.author.id,
    ownerFeaturesAllowed: true,
    tools: (toolContext) => {
      tools = buildTools(toolContext);
      return tools;
    },
  });
  await agent.promptMessage(message);
  await agent.steerMessage(message);
  assert.ok(prompts.every((turn) => !("ownerFeaturesAllowed" in turn.event)));
  const read = tools.find((tool) => tool.name === "discord_read");
  assert.ok(read);
  await read.execute(
    "read",
    { messageId: message.id },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
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
  const store = new InMemoryScheduledTaskStore();
  async function createSessionTools(
    sessionKey: string,
    channelId: string,
    ownerFeaturesAllowed: boolean,
    ownerUserId?: string,
  ) {
    let tools: readonly ToolDefinition[] = [];
    const buildTools = createToolsFor(createStubDiscordChannelApi(), channelId, {
      ownerFeaturesAllowed,
      ownerUserId,
      scheduledTaskStore: store,
    });
    await DiscordAgent.create(
      {
        async create(_definition, createAgentTools) {
          createAgentTools({ requesterId: () => undefined });
          return {
            async prompt() {
              return undefined;
            },
            dispose() {},
          };
        },
      },
      channelId,
      "system",
      {
        sessionKey,
        ownerFeaturesAllowed,
        ownerUserId,
        tools: (toolContext) => {
          tools = buildTools(toolContext);
          return tools;
        },
      },
    );
    return tools;
  }

  const original = await createSessionTools("session-old", "channel-a", false, "123");
  const added = await executeToolByName(original, "reminder_add", {
    message: "定例会",
    schedule: { type: "after", minutes: 1 },
  });
  const id = requireStringField(added.details, "id");
  const rotated = await createSessionTools("session-new", "channel-a", false, "123");
  const rotatedList = requireDetailsRecord(
    (await executeToolByName(rotated, "reminder_list", {})).details,
  ).reminders;
  assert.ok(Array.isArray(rotatedList));
  assert.equal(rotatedList.length, 1);

  for (const tools of [
    await createSessionTools("session-new", "channel-b", false, "123"),
    await createSessionTools("session-new", "channel-a", true, "123"),
    await createSessionTools("session-new", "channel-a", true, "456"),
  ]) {
    assert.deepEqual(
      requireDetailsRecord((await executeToolByName(tools, "reminder_list", {})).details).reminders,
      [],
    );
    assert.equal(
      requireDetailsRecord((await executeToolByName(tools, "reminder_delete", { id })).details)
        .deleted,
      false,
    );
  }
  assert.equal(
    requireDetailsRecord((await executeToolByName(rotated, "reminder_delete", { id })).details)
      .deleted,
    true,
  );
  for (const [allowed, userId, expectedScope] of [
    [true, "123", "owner:123"],
    [true, undefined, "public"],
    [false, "123", "public"],
  ] as const) {
    const tools = await createSessionTools("session-any", "channel-a", allowed, userId);
    const result = await executeToolByName(tools, "reminder_add", {
      message: "通知",
      schedule: { type: "after", minutes: 1 },
    });
    assert.equal(
      store.tasks.get(requireStringField(result.details, "id"))?.accessScope,
      expectedScope,
    );
  }
});

test("exposes watch tools in every session with the session scope", async () => {
  const store = new InMemoryScheduledTaskStore();
  const ownerTools = createToolsFor(createStubDiscordChannelApi(), "channel-a", {
    ownerFeaturesAllowed: true,
    ownerUserId: "123",
    scheduledTaskStore: store,
  })(createStubAgentToolContext());
  const publicTools = createToolsFor(createStubDiscordChannelApi(), "channel-a", {
    ownerFeaturesAllowed: false,
    ownerUserId: "123",
    scheduledTaskStore: store,
  })(createStubAgentToolContext());

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
    },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
  assert.equal(store.created.at(-1)?.accessScope, "public");
});
