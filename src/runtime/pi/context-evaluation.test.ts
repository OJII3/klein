import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import pino from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import { createDiscordAgentTools } from "@agents/discord/discord-tools";
import { loadPromptFile } from "@app/prompt";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import { JsonMemoryStore } from "@modules/memory/infrastructure/json-memory-store";
import { createWatchFetchTool } from "./watch-fetch-tool";
import { QuickJsWatchCheckRunner } from "@modules/scheduling/application/quickjs-watch-check-runner";
import { FileScheduledTaskStore } from "@modules/scheduling/infrastructure/file-scheduled-task-store";
import { MarkdownUserMemoryStore } from "@modules/user-memory/infrastructure/markdown-user-memory-store";
import { DiscordUserDirectory } from "@modules/discord/application/discord-user-directory";

import { readFile } from "node:fs/promises";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { createTempDir } from "../../testing/temp-dir";
import {
  analyzeCapturedRequest,
  buildContextJudgePrompt,
  comparePrefixStability,
  createContextEvaluationHarness,
  evaluateEvalFeedbackCase,
  evaluateSessionEntries,
  extractSessionTurns,
  renderContextEvaluationMarkdown,
} from "./context-evaluation";
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

async function setupEvaluationAgent(options: {
  readonly provider: string;
  readonly model: string;
  readonly ownerFeaturesAllowed?: boolean;
  readonly handoffContext?: string;
  readonly withImageModel?: boolean;
  readonly profile?: "klein" | "yachiyo";
}) {
  const temp = await createTempDir("klein-eval-agent-");
  const agentDir = join(temp.path, "pi");
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

  const harness = await createContextEvaluationHarness({
    providers: ["opencode-go", "google", "mistral"],
    onCompleteSimple: async () =>
      fauxAssistantMessage("画像にはテスト用の白い矩形が描かれています。"),
  });

  const channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
  > = {
    async readMessage(target) {
      return createDiscordMessage({
        id: target.messageId,
        channelId: target.channelId,
        content: "参照された過去メッセージです。",
      });
    },
    async sendMessage() {},
    async sendTyping() {},
    async sendAudio() {},
  };

  const watchToolCatalog = { tools: [createWatchFetchTool({ agentDir })] };
  const watchCheckRunner = new QuickJsWatchCheckRunner({ tools: watchToolCatalog.tools });
  const scheduledTaskStore = new FileScheduledTaskStore(join(temp.path, "schedules"));
  const ownerMemoryStore = new OwnerMemoryStore(
    new JsonMemoryStore(join(temp.path, "owner-memory", "MEMORY.json")),
  );
  const userMemoryStore = new MarkdownUserMemoryStore(join(temp.path, "user-memory"));
  const discordUserDirectory = new DiscordUserDirectory(
    join(temp.path, "discord-users.json"),
    SILENT_LOGGER,
  );
  const profile = options.profile ?? "klein";
  const systemPrompt = await loadPromptFile(`config/${profile}/SOUL.md`);

  // Disable Pi background cache warming inside dry-run evaluation sessions.
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }), "utf8");

  const factory = createPiAgentFactory({
    agentDir,
    llm: {
      provider: options.provider,
      model: options.model,
      thinkingLevel: "low",
      ...(options.withImageModel
        ? {
            image: {
              provider: options.provider,
              model: options.model,
              thinkingLevel: "low" as const,
            },
          }
        : {}),
    },
    skillsDirectory: `config/${profile}/skills`,
    logger: SILENT_LOGGER,
    modelRuntime: harness.modelRuntime,
    sessionMode: "new",
    watchToolCatalog,
    extraExtensions: [harness.captureExtension],
  });

  const agent = await DiscordAgent.create(factory, "ch-1", systemPrompt, {
    sessionKey: "eval-session",
    handoffContext: options.handoffContext,
    ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
    ownerUserId: "owner-1",
    tools: (analyzeImage) =>
      createDiscordAgentTools(
        {
          channelApi,
          channelId: "ch-1",
          ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
          ownerUserId: "owner-1",
          scheduledTaskStore,
          watchCheckRunner,
          ownerMemoryStore,
          userMemoryStore,
          discordUserDirectory,
        },
        analyzeImage,
      ),
  });

  return {
    agent,
    harness,
    async cleanup() {
      agent.dispose();
      harness.dispose();
      if (previousAgentDirEnv === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
      }
      await temp[Symbol.asyncDispose]();
    },
  };
}

test("verifies full extension ordering, turn-context replacement, assistant normalization, and prefix stability", async () => {
  const env = await setupEvaluationAgent({
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    ownerFeaturesAllowed: false,
    handoffContext: "前回の会話では天気と予定について話していた。",
  });

  try {
    env.harness.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "内部思考: メッセージを確認する" },
        fauxToolCall("discord_read", { messageId: "ref-1" }),
      ]),
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "うん、元気だよ。" })]),
      fauxAssistantMessage("完了（ツール外テキスト）"),
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "了解、またあとで。" })]),
      fauxAssistantMessage("2ターン目完了"),
    ]);

    env.harness.setNextLabel("turn1-initial");
    await env.agent.promptMessage(
      createDiscordMessage({ id: "m1", content: "調子どう？ <@bot>" }),
      {
        userMemory: "Alice: よく挨拶してくれる",
        guildMemory: "雑談チャンネル",
        channelRule: "短めに返答する",
      },
    );

    env.harness.setNextLabel("turn2-after-first-turn");
    await env.agent.promptMessage(
      createDiscordMessage({ id: "m2", content: "ありがとう、じゃあまたね！" }),
      {
        userMemory: "Bob: 初対面",
      },
    );

    assert.ok(env.harness.requests.length >= 4);

    // Request 0: handoff -> turn-context -> event
    const req0 = analyzeCapturedRequest(env.harness.requests[0]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.deepEqual(
      req0.messages.map((m) => m.kind),
      ["context-handoff", "turn-context", "event"],
    );
    assert.deepEqual(
      req0.findings.filter((f) => f.severity === "error"),
      [],
    );

    // Request 1 (tool result follow-up inside turn 1): turn-context stays before user event, active tool call intact.
    const req1 = analyzeCapturedRequest(env.harness.requests[1]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.deepEqual(
      req1.messages.map((m) => m.kind),
      [
        "context-handoff",
        "turn-context",
        "event",
        "assistant-tool-call",
        "tool-result:discord_read",
      ],
    );

    // Prefix stability across tool call in the same turn should keep leading system + handoff + turn-context + event intact.
    const intraTurnStability = comparePrefixStability(
      env.harness.requests[0]!,
      env.harness.requests[1]!,
    );
    assert.ok(intraTurnStability.transcript.ratio > 0.9);

    // Request 3 (start of turn 2): old turn-context is replaced, previous completed assistant text is normalized.
    const turn2Start = env.harness.requests.find((req) => req.label === "turn2-after-first-turn")!;
    assert.ok(turn2Start);
    const reqTurn2 = analyzeCapturedRequest(turn2Start, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    const turnContexts = reqTurn2.messages.filter((m) => m.kind === "turn-context");
    assert.equal(turnContexts.length, 1);
    assert.ok(turnContexts[0]!.text.includes("Bob: 初対面"));
    assert.ok(!turnContexts[0]!.text.includes("Alice: よく挨拶してくれる"));

    // Turn-context must appear immediately before the latest user event.
    const lastEventIndex = reqTurn2.messages.findLast((m) => m.kind === "event")!.index;
    assert.ok(turnContexts[0]!.index < lastEventIndex);

    // Completed assistant turns from turn 1 must be normalized to outcome summary.
    const completedAssistant = reqTurn2.messages.filter((m) => m.kind === "assistant-text");
    assert.ok(completedAssistant.some((m) => m.text === "Sent a message to Discord."));
    assert.deepEqual(
      reqTurn2.findings.filter((f) => f.severity === "error"),
      [],
    );
  } finally {
    await env.cleanup();
  }
});

test("enforces owner access boundaries and orders image analysis and bot guidance cleanly", async () => {
  const publicEnv = await setupEvaluationAgent({
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    ownerFeaturesAllowed: false,
    withImageModel: true,
  });

  const ownerEnv = await setupEvaluationAgent({
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    ownerFeaturesAllowed: true,
    withImageModel: true,
  });

  try {
    await publicEnv.agent.promptMessage(
      createDiscordMessage({
        id: "bot-img-1",
        author: { id: "other-bot", username: "otherbot", displayName: "OtherBot", bot: true },
        content: "この画像を見て！",
        images: [{ id: "img-1", filename: "sample.png", data: "aGVsbG8=", mimeType: "image/png" }],
      }),
      {
        ownerMemory: "secret owner memory",
        guildMemory: "guild fact",
      },
    );

    const publicAnalysis = analyzeCapturedRequest(publicEnv.harness.requests[0]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.equal(
      publicAnalysis.tools.some((t) => t.name.startsWith("owner_memory_")),
      false,
    );
    assert.equal(
      publicAnalysis.messages.some((m) => m.text.includes("secret owner memory")),
      false,
    );
    assert.deepEqual(
      publicAnalysis.messages.map((m) => m.kind),
      ["image-analysis", "turn-context", "event"],
    );
    const eventMessage = publicAnalysis.messages.at(-1)!;
    assert.ok(eventMessage.text.includes("The latest Discord message was sent by another bot."));
    assert.deepEqual(publicAnalysis.findings, []);

    await ownerEnv.agent.promptMessage(
      createDiscordMessage({
        id: "owner-1",
        author: { id: "owner-1", username: "owner", displayName: "Owner", bot: false },
        content: "オーナーメモ確認して",
      }),
      {
        ownerMemory: "owner private note",
      },
    );

    const ownerAnalysis = analyzeCapturedRequest(ownerEnv.harness.requests[0]!, {
      ownerFeaturesAllowed: true,
      expectProviderPayload: true,
    });
    assert.equal(
      ownerAnalysis.tools.some((t) => t.name.startsWith("owner_memory_")),
      true,
    );
    assert.equal(
      ownerAnalysis.messages.some((m) => m.text.includes("owner private note")),
      true,
    );
    assert.deepEqual(ownerAnalysis.findings, []);
  } finally {
    await publicEnv.cleanup();
    await ownerEnv.cleanup();
  }
});

for (const target of [
  { provider: "opencode-go", model: "deepseek-v4.1-flash", expectedApi: "openai-completions" },
  { provider: "google", model: "gemini-2.5-flash", expectedApi: "google-generative-ai" },
  { provider: "mistral", model: "deepseek-v4-1-flash-1017", expectedApi: "mistral-conversations" },
] as const) {
  test(`captures valid provider payload for ${target.provider}/${target.model}`, async () => {
    const env = await setupEvaluationAgent({
      provider: target.provider,
      model: target.model,
      ownerFeaturesAllowed: false,
      profile: "yachiyo",
    });

    try {
      await env.agent.promptMessage(
        createDiscordMessage({ id: "m-provider", content: "やちよ、テストだよ" }),
        { guildMemory: "月見チャンネルの記憶" },
      );

      assert.equal(env.harness.requests.length, 1);
      const req = env.harness.requests[0]!;
      assert.equal(req.model.api, target.expectedApi);

      const analysis = analyzeCapturedRequest(req, {
        ownerFeaturesAllowed: false,
        expectProviderPayload: true,
      });
      assert.ok(analysis.providerView);
      assert.ok(analysis.providerView.systemInstructionChars > 0);
      assert.equal(analysis.providerView.toolCount, analysis.tools.length);
      assert.ok(analysis.providerView.messageCount >= 2);
      assert.deepEqual(
        analysis.findings.filter((f) => f.severity === "error"),
        [],
      );

      const markdown = renderContextEvaluationMarkdown(env.harness.requests, {
        title: `Eval (${target.provider}/${target.model})`,
        ownerFeaturesAllowed: false,
      });
      assert.ok(markdown.includes("## Overview"));
      assert.ok(markdown.includes("### System Prompt"));
      assert.ok(markdown.includes("### Declared Tools"));
      assert.ok(markdown.includes("### Messages Sequence"));

      const judgePrompt = buildContextJudgePrompt(markdown);
      assert.ok(judgePrompt.userPrompt.includes("ordering_and_boundaries"));
    } finally {
      await env.cleanup();
    }
  });
}

test("extracts turns from a persisted session JSONL and evaluates them in turn-start and pre-message modes", async () => {
  const temp = await createTempDir("klein-eval-persisted-");
  const agentDir = join(temp.path, "pi");
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }), "utf8");

  const harness = await createContextEvaluationHarness({
    providers: ["opencode-go"],
    responses: [
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "1ターン目の返答" })]),
      fauxAssistantMessage("turn 1 ok"),
      fauxAssistantMessage([fauxToolCall("discord_read", { messageId: "ref-99" })]),
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "2ターン目の返答" })]),
      fauxAssistantMessage("turn 2 ok"),
    ],
  });

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
    modelRuntime: harness.modelRuntime,
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
    assert.equal(turns[1]?.hasTurnContext, true);

    const allTurnsEval = await evaluateSessionEntries({
      entries,
      sessionKey: "discord-channel:ch-session",
      ownerFeaturesAllowed: false,
      allTurns: true,
      mode: "turn-start",
    });
    assert.equal(allTurnsEval.evaluatedTurns.length, 2);
    assert.equal(allTurnsEval.requests.length, 2);

    const turn2Analysis = analyzeCapturedRequest(allTurnsEval.requests[1]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.equal(
      turn2Analysis.messages.some(
        (m) => m.kind === "assistant-text" && m.text === "Sent a message to Discord.",
      ),
      true,
    );
    assert.equal(
      turn2Analysis.messages.some(
        (m) => m.kind === "turn-context" && m.text.includes("簡潔に答える"),
      ),
      true,
    );
    assert.deepEqual(
      turn2Analysis.findings.filter((f) => f.severity === "error"),
      [],
    );

    const preMessageEval = await evaluateSessionEntries({
      entries,
      sessionKey: "discord-channel:ch-session",
      ownerFeaturesAllowed: false,
      turnIndex: 1,
      mode: "pre-message",
    });
    assert.equal(preMessageEval.requests.length, 1);
    const preAnalysis = analyzeCapturedRequest(preMessageEval.requests[0]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.equal(
      preAnalysis.messages.some((m) => m.kind === "tool-result:discord_read"),
      true,
    );
  } finally {
    agent.dispose();
    harness.dispose();
    if (previousAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    }
    await temp[Symbol.asyncDispose]();
  }
});

test("records a negative-reaction snapshot from PiAgentRuntime and evaluates it later in pre-message and turn-start modes", async () => {
  const temp = await createTempDir("klein-eval-e2e-reaction-");
  const agentDir = join(temp.path, "pi");
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off" }), "utf8");

  const sentMessageIndex = new SentMessageSessionIndex(agentDir);
  const caseStore = new SessionEvalCaseStore({ agentDir, index: sentMessageIndex });

  const harness = await createContextEvaluationHarness({
    providers: ["opencode-go"],
    responses: [
      fauxAssistantMessage([fauxToolCall("discord_read", { messageId: "prev-1" })]),
      fauxAssistantMessage([fauxToolCall("discord_send", { content: "的外れな返答です" })]),
      fauxAssistantMessage("completed"),
    ],
  });

  let sendCounter = 0;
  const channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
  > = {
    async readMessage(target) {
      return createDiscordMessage({ id: target.messageId, content: "元の文脈メッセージ" });
    },
    async sendMessage() {
      return [`discord-bad-${++sendCounter}`];
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
    modelRuntime: harness.modelRuntime,
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
    assert.equal(recordedCase.recordedResponse.content, "的外れな返答です");

    const loaded = await caseStore.loadCase(recordedCase.caseId);
    assert.ok(loaded);

    // Default mode should infer pre-message because discord_read preceded discord_send.
    const preResult = await evaluateEvalFeedbackCase(loaded);
    assert.equal(preResult.mode, "pre-message");
    assert.equal(preResult.requests.length, 1);

    const preAnalysis = analyzeCapturedRequest(preResult.requests[0]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.equal(
      preAnalysis.messages.some((m) => m.kind === "tool-result:discord_read"),
      true,
    );
    assert.equal(
      preAnalysis.messages.some((m) => m.text.includes("的外れな返答です")),
      false,
    );
    assert.deepEqual(
      preAnalysis.findings.filter((f) => f.severity === "error"),
      [],
    );

    // Explicit turn-start mode replays from the user prompt with current SOUL.md + tools.
    const turnStartResult = await evaluateEvalFeedbackCase(loaded, { mode: "turn-start" });
    assert.equal(turnStartResult.mode, "turn-start");
    assert.equal(turnStartResult.requests.length, 1);
    const turnStartAnalysis = analyzeCapturedRequest(turnStartResult.requests[0]!, {
      ownerFeaturesAllowed: false,
      expectProviderPayload: true,
    });
    assert.deepEqual(
      turnStartAnalysis.messages.map((m) => m.kind),
      ["turn-context", "event"],
    );

    const reportMarkdown = renderContextEvaluationMarkdown(preResult.requests, {
      title: `Feedback ${loaded.caseMeta.caseId}`,
      ownerFeaturesAllowed: false,
    });
    const judgePrompt = buildContextJudgePrompt(reportMarkdown, {
      caseId: loaded.caseMeta.caseId,
      reaction: loaded.caseMeta.reaction,
      recordedResponse: loaded.caseMeta.recordedResponse,
    });
    assert.ok(judgePrompt.userPrompt.includes("的外れな返答です"));
    assert.ok(judgePrompt.userPrompt.includes("👎"));
  } finally {
    agent.dispose();
    harness.dispose();
    if (previousAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    }
    await temp[Symbol.asyncDispose]();
  }
});
