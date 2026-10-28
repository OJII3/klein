import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentFactory } from "@agents/core/agent-factory";
import { DiscordAgent } from "@agents/discord/discord-agent";
import { DomainAgent } from "@agents/domain/domain-agent";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import { createAgentSystem } from "./agent-system";
import { TaskCoordinator } from "./task-coordinator";

const OWNER_ID = "123456789012345678";

function createOwnerMessage(channelId: string, id: string, content: string): DiscordMessage {
  return {
    author: {
      bot: false,
      id: OWNER_ID,
      username: "owner",
      displayName: "オーナー",
    },
    channelId,
    content,
    id,
    occurredAt: "2026-10-14T09:00:00.000Z",
    images: [],
  };
}

test("coordinates domain agent direct channel reply, owner memory update, and event routing to communication agent", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "klein-multi-agent-"));
  const ownerMemoryStore = new OwnerMemoryStore(join(tempDir, "owner-memory", "MEMORY.json"));
  const taskCoordinator = new TaskCoordinator();
  const sentMessages: Array<{ channelId: string; text: string }> = [];
  const communicationEvents: AgentEvent[] = [];
  const calendarEvents: AgentEvent[] = [];

  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
    async sendTyping() {},
    async sendMessage(channelId, text) {
      sentMessages.push({ channelId, text });
    },
    async sendAudio() {},
    async readMessage(locator) {
      return createOwnerMessage(locator.channelId, locator.messageId, "本文");
    },
    async getChannelLocation(channelId) {
      return { guildId: "owner-guild", channelId };
    },
    async stop() {},
  };

  let calendarTools: readonly ToolRegistration[] = [];
  const agentFactory: AgentFactory = {
    async create(definition, tools, options) {
      if (definition.outputMode === "assistant_text") {
        calendarTools = tools;
        return {
          async prompt(event) {
            calendarEvents.push(event);
            // Simulate domain agent adding to owner memory and sending an event to communication agent
            const memoryAdd = calendarTools.find((tool) => tool.name === "owner_memory_add");
            const sendEvent = calendarTools.find((tool) => tool.name === "agent_send_event");
            assert.ok(memoryAdd);
            assert.ok(sendEvent);
            await memoryAdd.execute(
              {
                kind: "temporary",
                title: "緊急MTGの追加",
                content: "本日14:00に緊急の設計レビューMTGが追加された",
              },
              { callId: "mem-1" } as never,
              {} as never,
            );
            await sendEvent.execute(
              {
                targetAgent: "communication",
                eventType: "calendar.urgent",
                message: "本日14:00に緊急の設計レビューMTGが入りました。オーナーへ伝えてください。",
              },
              { callId: "evt-1" } as never,
              {} as never,
            );
            return {
              assistantText:
                "カレンダーを確認し、14:00の緊急MTGをメモリに記録してコミュニケーションエージェントへ共有しました。",
            };
          },
          dispose() {},
        };
      }

      assert.equal(options.ownerFeaturesAllowed, true);
      return {
        async prompt(event) {
          communicationEvents.push(event);
        },
        dispose() {},
      };
    },
  };

  const accessPolicy = createDiscordAccessPolicy(
    { default: "deny", directMessages: "deny" },
    OWNER_ID,
    ["comm-channel", "calendar-channel"],
  );

  const agentSystem = createAgentSystem({
    accessPolicy,
    communicationChannelId: "comm-channel",
    ownerUserId: OWNER_ID,
    ownerMemoryStore,
    discordService,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    taskCoordinator,
    createDiscordAgent: (
      eventRouter,
      channelId,
      sessionKey,
      handoffContext,
      ownerFeaturesAllowed,
    ) =>
      DiscordAgent.create(agentFactory, discordService, channelId, "Communication SOUL", {
        eventRouter,
        handoffContext,
        ownerFeaturesAllowed,
        ownerMemoryStore,
        ownerUserId: OWNER_ID,
        sessionKey,
      }),
    domainAgents: {
      calendar: {
        channelId: "calendar-channel",
        createAgent: (eventRouter, sessionKey, handoffContext) =>
          DomainAgent.create(agentFactory, {
            agentId: "calendar",
            channelId: "calendar-channel",
            discordService,
            eventRouter,
            handoffContext,
            ownerMemoryStore,
            ownerUserId: OWNER_ID,
            sessionKey,
            systemPrompt: "Calendar Agent Prompt",
          }),
      },
    },
  });
  const { agentCoordinator, discordMessageIngress } = agentSystem;

  try {
    // 1. Owner sends a message to the calendar domain agent channel
    await discordMessageIngress.handleDiscordMessage(
      createOwnerMessage("calendar-channel", "msg-cal-1", "今日の予定をチェックして"),
    );
    // Wait for background dispatched event to communication agent to complete
    await taskCoordinator.waitForCompletion();

    // 2. Domain agent's assistantText was sent directly to calendar-channel
    assert.deepEqual(sentMessages, [
      {
        channelId: "calendar-channel",
        text: "カレンダーを確認し、14:00の緊急MTGをメモリに記録してコミュニケーションエージェントへ共有しました。",
      },
    ]);

    // 3. Communication agent received the calendar.urgent event with <owner-memory> injected
    assert.equal(communicationEvents.length, 1);
    assert.equal(communicationEvents[0]?.type, "calendar.urgent");
    assert.equal(communicationEvents[0]?.source, "agent:calendar");
    const commText =
      communicationEvents[0]?.content[0]?.type === "text"
        ? communicationEvents[0].content[0].text
        : "";
    assert.match(commText, /<owner-memory>/);
    assert.match(commText, /本日14:00に緊急の設計レビューMTGが追加された/);
    assert.match(commText, /本日14:00に緊急の設計レビューMTGが入りました/);
  } finally {
    await agentCoordinator.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
});
