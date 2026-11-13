import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type AssistantMessageEventStream,
  type FauxResponseStep,
  type Model,
  type ModelsSimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import pino from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import { createDiscordAgentTools } from "@agents/discord/discord-tools";
import { loadPromptFile } from "@app/prompt";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { QuickJsWatchCheckRunner } from "@modules/scheduling/application/quickjs-watch-check-runner";

import { createTempDir } from "../../testing/temp-dir";
import {
  extractSessionTurns,
  extractTurnTraceFromEntries,
  formatContextInspectionMarkdown,
  formatReplayResultMarkdown,
  inspectFeedbackCase,
  inspectSessionEntries,
  replayFeedbackCase,
} from "./context-inspector";
import { createPiAgentFactory } from "./pi-agent-runtime";
import { SentMessageSessionIndex, SessionEvalCaseStore } from "./session-eval-store";

const SILENT_LOGGER = pino({ level: "silent" });

function createDiscordMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: overrides.id ?? "msg-1",
    channelId: overrides.channelId ?? "ch-1",
    guildId: overrides.guildId ?? "guild-1",
    channelName: overrides.channelName ?? "general",
    occurredAt: overrides.occurredAt ?? "2026-10-14T09:30:00.000Z",
    author: overrides.author ?? {
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      bot: false,
    },
    content: overrides.content ?? "こんにちは！調子どう？",
    replyTo: overrides.replyTo,
    images: overrides.images ?? [],
  };
}

async function createMockModelRuntime(
  tempDir: string,
  responses: readonly FauxResponseStep[],
): Promise<ModelRuntime> {
  await mkdir(tempDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(tempDir, "auth.json"),
    modelsPath: join(tempDir, "models.json"),
    modelsStorePath: join(tempDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("opencode-go", "mock-key");

  const fauxCore = createFauxCore({
    models: [
      {
        id: "mock-faux",
        name: "Mock Faux",
        reasoning: false,
        input: ["text", "image"],
      },
    ],
  });
  fauxCore.setResponses([...responses]);

  modelRuntime.streamSimple = ((
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      await streamOptions?.onPayload?.({ model: model.id, messages: context.messages }, model);
      if (fauxCore.getPendingResponseCount() === 0) {
        fauxCore.appendResponses([fauxAssistantMessage("OK")]);
      }
      const stream = fauxCore.streamSimple(
        model as unknown as Model<string>,
        context,
        streamOptions,
      );
      for await (const event of stream) {
        outer.push(event);
        if (event.type === "done" || event.type === "error") {
          outer.end(event.type === "done" ? event.message : event.error);
          return;
        }
      }
      outer.end();
    })();
    return outer;
  }) as typeof modelRuntime.streamSimple;

  return modelRuntime;
}

test("inspects turns and raw context from a persisted session JSONL in turn-start and pre-message modes", async () => {
  const temp = await createTempDir("klein-inspect-persisted-");
  const agentDir = join(temp.path, "pi");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }), "utf8");

  const mockRuntime = await createMockModelRuntime(temp.path, [
    fauxAssistantMessage([fauxToolCall("discord_send", { content: "1ターン目の返答" })]),
    fauxAssistantMessage("turn 1 ok"),
    fauxAssistantMessage([
      { type: "thinking", thinking: "過去ログを確認しよう" },
      fauxToolCall("discord_read", { messageId: "ref-99" }),
    ]),
    fauxAssistantMessage([fauxToolCall("discord_send", { content: "2ターン目の返答" })]),
    fauxAssistantMessage("turn 2 ok"),
  ]);

  let sessionFilePath: string | undefined;
  const factory = createPiAgentFactory({
    agentDir,
    llm: {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      thinkingLevel: "low",
    },
    skillsDirectory: "config/klein/skills",
    logger: SILENT_LOGGER,
    modelRuntime: mockRuntime,
    sessionMode: "new",
    onSessionCreated: (session) => {
      sessionFilePath = session.sessionFile;
    },
  });

  const channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
  > = {
    async readMessage(target) {
      return createDiscordMessage({ id: target.messageId, content: "参照メッセージ内容" });
    },
    async sendMessage() {
      return ["sent-msg-1"];
    },
    async sendTyping() {},
    async sendAudio() {},
  };

  const agent = await DiscordAgent.create(
    factory,
    "ch-session",
    await loadPromptFile("config/klein/SOUL.md"),
    {
      sessionKey: "discord-channel:ch-session",
      ownerFeaturesAllowed: false,
      ownerUserId: "owner-1",
      tools: (analyzeImage) =>
        createDiscordAgentTools(
          {
            channelApi,
            channelId: "ch-session",
            ownerFeaturesAllowed: false,
            ownerUserId: "owner-1",
            watchCheckRunner: new QuickJsWatchCheckRunner({ tools: [] }),
          },
          analyzeImage,
        ),
    },
  );

  try {
    await agent.promptMessage(createDiscordMessage({ id: "u-1", content: "おはよう <@bot>" }), {
      userMemory: "Alice: 朝型",
    });
    await agent.promptMessage(
      createDiscordMessage({ id: "u-2", content: "昨日の件確認して <@bot>" }),
      {
        channelRule: "簡潔に答える",
      },
    );

    assert.ok(sessionFilePath);
    const entries = parseSessionEntries(await readFile(sessionFilePath, "utf8"));
    const turns = extractSessionTurns(entries);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0]?.discordSendContents, ["1ターン目の返答"]);
    assert.deepEqual(turns[1]?.discordSendContents, ["2ターン目の返答"]);

    const trace = extractTurnTraceFromEntries(entries, { turnIndex: 1 });
    assert.ok(trace);
    assert.ok(trace.turnContextText?.includes("簡潔に答える"));
    assert.ok(trace.steps.some((step) => step.thinking === "過去ログを確認しよう"));
    assert.ok(trace.steps.some((step) => step.toolName === "discord_read"));

    const turnStartResult = await inspectSessionEntries({
      entries,
      sessionKey: "discord-channel:ch-session",
      ownerFeaturesAllowed: false,
      turnIndex: 1,
      mode: "turn-start",
      captureProviderPayload: true,
    });
    assert.equal(turnStartResult.requests.length, 1);
    const req = turnStartResult.requests[0]!;
    assert.ok(req.systemPrompt.length > 0);
    assert.ok(req.tools.some((tool) => tool.name === "discord_send"));
    assert.ok(req.providerPayload !== undefined);
    assert.ok(
      req.contextWithSystem.some(
        (m) => m.role === "assistant" && m.text === "Sent a message to Discord.",
      ),
    );
    assert.ok(
      req.contextWithSystem.some(
        (m) => m.customType === "klein-turn-context" && m.text.includes("簡潔に答える"),
      ),
    );

    const preMessageResult = await inspectSessionEntries({
      entries,
      sessionKey: "discord-channel:ch-session",
      ownerFeaturesAllowed: false,
      turnIndex: 1,
      mode: "pre-message",
      captureProviderPayload: true,
    });
    assert.equal(preMessageResult.requests.length, 1);
    assert.ok(
      preMessageResult.requests[0]!.transcriptMessages.some(
        (m) => m.role === "toolResult" && m.toolName === "discord_read",
      ),
    );

    const markdown = formatContextInspectionMarkdown(preMessageResult, {
      includeTools: true,
      includeProviderPayload: true,
    });
    assert.ok(markdown.includes("## Recorded Turn Trace"));
    assert.ok(markdown.includes("### System Prompt (Raw)"));
    assert.ok(markdown.includes("### Declared Tools"));
    assert.ok(markdown.includes("### Provider HTTP Payload (Raw JSON)"));
  } finally {
    agent.dispose();
    await temp[Symbol.asyncDispose]();
  }
});

test("records a 👎 feedback case, inspects original trace + raw context, and replays with a runtime", async () => {
  const temp = await createTempDir("klein-inspect-e2e-reaction-");
  const agentDir = join(temp.path, "pi");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }), "utf8");

  const sentMessageIndex = new SentMessageSessionIndex(agentDir);
  const caseStore = new SessionEvalCaseStore({ agentDir, index: sentMessageIndex });

  const initialRuntime = await createMockModelRuntime(join(temp.path, "initial-rt"), [
    fauxAssistantMessage([fauxToolCall("discord_read", { messageId: "prev-1" })]),
    fauxAssistantMessage([
      { type: "text", text: "このまま答えてしまおう" },
      fauxToolCall("discord_send", { content: "的外れな返答です" }),
    ]),
    fauxAssistantMessage("completed"),
  ]);

  const channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
  > = {
    async readMessage(target) {
      return createDiscordMessage({ id: target.messageId, content: "元の文脈メッセージ" });
    },
    async sendMessage() {
      return ["discord-bad-1"];
    },
    async sendTyping() {},
    async sendAudio() {},
  };

  const factory = createPiAgentFactory({
    agentDir,
    llm: {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      thinkingLevel: "low",
    },
    skillsDirectory: "config/klein/skills",
    logger: SILENT_LOGGER,
    modelRuntime: initialRuntime,
    sessionMode: "new",
    sentMessageIndex,
  });

  const agent = await DiscordAgent.create(
    factory,
    "ch-feedback",
    await loadPromptFile("config/klein/SOUL.md"),
    {
      sessionKey: "discord-channel:ch-feedback",
      ownerFeaturesAllowed: false,
      ownerUserId: "owner-1",
      tools: (analyzeImage) =>
        createDiscordAgentTools(
          {
            channelApi,
            channelId: "ch-feedback",
            ownerFeaturesAllowed: false,
            ownerUserId: "owner-1",
            watchCheckRunner: new QuickJsWatchCheckRunner({ tools: [] }),
          },
          analyzeImage,
        ),
    },
  );

  try {
    await agent.promptMessage(
      createDiscordMessage({ id: "u-bad-1", content: "これについて教えて <@bot>" }),
      {
        guildMemory: "正確な情報だけを答えるチャンネル",
      },
    );

    const recordedCase = await caseStore.recordReactionFeedback(
      {
        emoji: "👎",
        userId: "user-1",
        userIsBot: false,
        channelId: "ch-feedback",
        guildId: "guild-1",
        messageId: "discord-bad-1",
        occurredAt: "2026-11-12T10:00:00.000Z",
      },
      { ownerUserId: "owner-1" },
    );
    assert.ok(recordedCase);

    const loaded = await caseStore.loadCase(recordedCase.caseId);
    assert.ok(loaded);

    const inspectedPre = await inspectFeedbackCase(loaded, { captureProviderPayload: true });
    assert.equal(inspectedPre.mode, "pre-message");
    assert.equal(inspectedPre.requests.length, 1);
    assert.equal(inspectedPre.trace?.recordedResponseContent, "的外れな返答です");
    assert.equal(inspectedPre.trace?.assistantTextBeforeCall, "このまま答えてしまおう");
    assert.ok(inspectedPre.trace?.steps.some((step) => step.toolName === "discord_read"));
    assert.ok(
      inspectedPre.requests[0]!.transcriptMessages.some(
        (m) => m.role === "toolResult" && m.toolName === "discord_read",
      ),
    );
    assert.ok(
      !inspectedPre.requests[0]!.transcriptMessages.some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes("的外れな返答です"),
      ),
    );

    const inspectedTurnStart = await inspectFeedbackCase(loaded, { mode: "turn-start" });
    assert.equal(inspectedTurnStart.mode, "turn-start");
    assert.equal(inspectedTurnStart.requests.length, 1);
    assert.ok(
      inspectedTurnStart.requests[0]!.contextWithSystem.some(
        (m) => m.customType === "klein-turn-context" && m.text.includes("正確な情報だけ"),
      ),
    );

    const replayRuntime = await createMockModelRuntime(join(temp.path, "replay-rt"), [
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "改善後の確認済み返答です" })]),
      fauxAssistantMessage("replayed"),
    ]);
    const replayed = await replayFeedbackCase(loaded, {
      mode: "turn-start",
      modelRuntime: replayRuntime,
      captureProviderPayload: true,
    });
    assert.equal(replayed.mode, "turn-start");
    assert.deepEqual(replayed.sentMessages, ["改善後の確認済み返答です"]);
    assert.equal(replayed.finalAssistantText, "replayed");
    assert.ok(replayed.requests.length >= 1);

    const replayMarkdown = formatReplayResultMarkdown(replayed, {
      caseMeta: loaded.caseMeta,
      includeProviderPayload: true,
    });
    assert.ok(replayMarkdown.includes("的外れな返答です"));
    assert.ok(replayMarkdown.includes("改善後の確認済み返答です"));
    assert.ok(replayMarkdown.includes("## Replayed Turn Steps"));
  } finally {
    agent.dispose();
    await temp[Symbol.asyncDispose]();
  }
});
