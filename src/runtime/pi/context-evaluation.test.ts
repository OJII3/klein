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

import { createTempDir } from "../../testing/temp-dir";
import {
  analyzeCapturedRequest,
  buildContextJudgePrompt,
  comparePrefixStability,
  createContextEvaluationHarness,
  renderContextEvaluationMarkdown,
} from "./context-evaluation";
import { createPiAgentFactory } from "./pi-agent-runtime";

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
