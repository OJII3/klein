import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { DISCORD_AGENT_TOOL_NAMES } from "@agents/discord/prompt-policy";
import { createDiscordReadTool } from "@agents/discord/tools/discord-read";
import { createDiscordSendTool } from "@agents/discord/tools/discord-send";
import { createPiAgentFactory } from "./pi-agent-runtime";

for (const restricted of [false, true]) {
  test(`codemode research respects tool permissions (restricted=${restricted})`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "klein-codemode-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const provider = fauxProvider({ tokensPerSecond: 100_000 });
    const model = provider.getModel();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    const factory = createPiAgentFactory({
      permissions: restricted ? { tools: { overrides: { discord_read: "owner" } } } : undefined,
      agentDir,
      llm: { provider: model.provider, model: model.id },
      logger: pino({ level: "silent" }),
      modelRuntime,
      sessionMode: "new",
    });
    const readIds: string[] = [];
    const sent: string[] = [];
    const readTool = createDiscordReadTool(
      {
        async readMessage({ messageId }) {
          readIds.push(messageId);
          return {
            author: { bot: false, id: "user", username: "user", displayName: "User" },
            channelId: "channel",
            content: `Unfiltered research content for ${messageId}`,
            id: messageId,
            occurredAt: "2026-10-14T09:30:42.123Z",
            images: [],
          };
        },
      },
      "channel",
    );
    const sendTool = createDiscordSendTool(
      {
        async sendTyping() {},
        async sendMessage(_channelId, content) {
          sent.push(content);
        },
      },
      "channel",
    );
    const runtime = await factory.create(
      {
        systemPrompt: "You are クライン. Keep your usual tone.",
        toolNames: DISCORD_AGENT_TOOL_NAMES,
      },
      [readTool, sendTool],
      { sessionKey: "codemode-test" },
    );

    try {
      const requests: TranscriptContext[] = [];
      provider.setResponses([
        (context) => {
          requests.push(context);
          return fauxAssistantMessage([
            { type: "text", text: "Checking the two messages before replying." },
            fauxToolCall("codemode", {
              code: `const results = await Promise.allSettled([
            tools.discord_read({ messageId: "first" }),
            tools.discord_read({ messageId: "second" }),
          ]);
          text(results.filter(result => result.status === "fulfilled").length);
          text({ canSend: "discord_send" in tools, canBash: "bash" in tools });`,
            }),
          ]);
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxToolCall("discord_send", { content: "……確認したよ" }));
        },
        fauxAssistantMessage("Finished"),
      ]);

      await runtime.prompt({
        id: "test-event",
        type: "message",
        source: "test",
        occurredAt: "2026-10-14T09:30:42.123Z",
        content: [{ type: "text", text: "二つのメッセージを確認して" }],
      });
      assert.equal(requests.length, 2);
      assert.deepEqual(
        getCurrentTools(requests[0].messages)
          .map((tool) => tool.name)
          .sort(),
        [...DISCORD_AGENT_TOOL_NAMES, "tool_search"]
          .filter((name) => !restricted || name !== "discord_read")
          .sort(),
      );
      assert.match(getCurrentSystemPrompt(requests[0].messages), /You are クライン/);
      const result = requests[1].messages
        .filter((message) => message.role === "toolResult" && message.toolName === "codemode")
        .at(-1);
      assert.ok(result && result.role === "toolResult");
      const output = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.equal(result.isError, restricted, output);
      if (restricted) {
        assert.match(output, /tools\.discord_read does not exist/);
      } else {
        assert.match(output, /Script completed/);
        assert.match(output, /\b2\b/);
        assert.match(output, /"canSend":false/);
        assert.match(output, /"canBash":false/);
      }
      assert.doesNotMatch(output, /Unfiltered research content/);
      const currentAssistant = requests[1].messages.find((message) => message.role === "assistant");
      assert.ok(currentAssistant && currentAssistant.role === "assistant");
      assert.ok(
        currentAssistant.content.some(
          (block) =>
            block.type === "text" && block.text === "Checking the two messages before replying.",
        ),
      );
      assert.deepEqual(readIds.sort(), restricted ? [] : ["first", "second"]);
      assert.deepEqual(sent, ["……確認したよ"]);

      provider.setResponses([
        (context) => {
          const previousAssistant = context.messages.find(
            (message) => message.role === "assistant",
          );
          assert.ok(previousAssistant && previousAssistant.role === "assistant");
          assert.ok(previousAssistant.content.some((block) => block.type === "toolCall"));
          assert.ok(previousAssistant.content.every((block) => block.type !== "text"));
          assert.deepEqual(
            context.messages
              .filter((message) => message.role === "assistant")
              .flatMap((message) => message.content.filter((block) => block.type === "text")),
            [{ type: "text", text: "Sent a message to Discord." }],
          );
          return fauxAssistantMessage("No further reply needed");
        },
      ]);
      await runtime.prompt({
        id: "test-event",
        type: "message",
        source: "test",
        occurredAt: "2026-10-14T09:30:42.123Z",
        content: [{ type: "text", text: "ありがとう" }],
      });
      assert.deepEqual(sent, ["……確認したよ"]);

      provider.setResponses([
        (context) => {
          assert.deepEqual(
            context.messages
              .filter((message) => message.role === "assistant")
              .flatMap((message) => message.content.filter((block) => block.type === "text")),
            [
              { type: "text", text: "Sent a message to Discord." },
              { type: "text", text: "Remained silent." },
            ],
          );
          return fauxAssistantMessage("No further reply needed");
        },
      ]);
      await runtime.prompt({
        id: "next-event",
        type: "message",
        source: "test",
        occurredAt: "2026-10-14T09:30:43.123Z",
        content: [{ type: "text", text: "次の話題" }],
      });
      assert.deepEqual(sent, ["……確認したよ"]);
    } finally {
      runtime.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { force: true, recursive: true });
    }
  });
}
