import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEvent } from "../core/agent-event";
import type { AgentEventRouter } from "../core/agent-event-router";
import type { AgentFactory } from "../core/agent-factory";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import { DomainAgent } from "./domain-agent";

const ownerMessage: DiscordMessage = {
  author: {
    bot: false,
    id: "123456789012345678",
    username: "owner",
    displayName: "オーナー",
  },
  channelId: "calendar-channel",
  content: "明日の予定を確認して",
  id: "msg-1",
  occurredAt: "2026-10-14T09:30:42.123Z",
  images: [],
};

test("DomainAgent uses assistant_text mode, sends assistantText to Discord channel, and suppresses NO_ACTION", async () => {
  const sentMessages: Array<{ channelId: string; text: string }> = [];
  let registeredTools: readonly ToolRegistration[] = [];
  let outputMode: string | undefined;
  let nextAssistantText = "明日は10:00から定例MTGがあります。";
  const receivedEvents: AgentEvent[] = [];

  const discordService = {
    async sendMessage(channelId: string, text: string) {
      sentMessages.push({ channelId, text });
    },
    async readMessage() {
      return ownerMessage;
    },
  } as unknown as DiscordService;

  const dispatchedEvents: Array<{ target: string; event: AgentEvent }> = [];
  const eventRouter: AgentEventRouter = {
    listTargets: () => ["communication", "calendar", "mail"],
    async dispatch(target, event) {
      dispatchedEvents.push({ target, event });
    },
  };

  const agentFactory: AgentFactory = {
    async create(definition, tools, options) {
      outputMode = definition.outputMode;
      registeredTools = tools;
      assert.equal(options.ownerFeaturesAllowed, true);
      assert.ok(!tools.some((tool) => tool.name === "discord_send"));
      assert.ok(tools.some((tool) => tool.name === "agent_send_event"));
      return {
        async prompt(event) {
          receivedEvents.push(event);
          return { assistantText: nextAssistantText };
        },
        dispose() {},
      };
    },
  };

  const agent = await DomainAgent.create(agentFactory, {
    agentId: "calendar",
    channelId: "calendar-channel",
    discordService,
    eventRouter,
    ownerUserId: ownerMessage.author.id,
    systemPrompt: "カレンダー管理エージェントです。",
  });

  assert.equal(outputMode, "assistant_text");

  await agent.prompt(ownerMessage, undefined, undefined, "### オーナー設定\n朝は9時始業");
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    channelId: "calendar-channel",
    text: "明日は10:00から定例MTGがあります。",
  });
  assert.match(
    receivedEvents[0]?.content[0]?.type === "text" ? receivedEvents[0].content[0].text : "",
    /<owner-memory>/,
  );

  // Background event returning NO_ACTION does not post to Discord channel
  nextAssistantText = "NO_ACTION";
  await agent.promptEvent({
    id: "evt-1",
    occurredAt: "2026-10-14T10:00:00.000Z",
    type: "reminder.due",
    source: "reminder",
    content: [{ type: "text", text: "定期チェック" }],
  });
  assert.equal(sentMessages.length, 1);

  // Can dispatch event to communication agent via agent_send_event tool
  const sendEventTool = registeredTools.find((tool) => tool.name === "agent_send_event");
  assert.ok(sendEventTool);
  await sendEventTool.execute(
    {
      targetAgent: "communication",
      eventType: "calendar.important",
      message: "15:00からのMTGが変更されました",
    },
    { callId: "call-1" } as never,
    {} as never,
  );
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0]?.target, "communication");
  assert.equal(dispatchedEvents[0]?.event.source, "agent:calendar");
  assert.equal(dispatchedEvents[0]?.event.type, "calendar.important");

  // Rejects non-owner messages
  assert.throws(
    () =>
      agent.prompt({
        ...ownerMessage,
        author: { ...ownerMessage.author, id: "someone-else" },
      }),
    /Only the owner/,
  );

  agent.dispose();
});
