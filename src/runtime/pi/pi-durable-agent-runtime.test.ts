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
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { createPiDurableAgentFactory } from "./pi-durable-agent-runtime";
import type { AgentRuntime } from "@agents/core/agent-runtime";

test("provides web tools and summarizes a durable conversation for handoff", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-handoff-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ provider: "opencode-go", tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const sessionKey = "discord-channel:handoff";
  const factory = createPiDurableAgentFactory({
    agentDir: join(agentDir, "durable"),
    modelRuntime,
    sessionMode: "resume",
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
  });

  try {
    const runtime = (await factory.create({ systemPrompt: "Test system prompt" }, [], {
      sessionKey,
    })) as AgentRuntime & { compactForHandoff(): Promise<string> };
    const requests: TranscriptContext[] = [];
    const sessionHeaders: Array<string | undefined> = [];
    provider.setResponses([
      (context, _options, _state, requestModel) => {
        requests.push(context);
        sessionHeaders.push(requestModel.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("Acknowledged");
      },
    ]);
    await runtime.prompt({
      id: "handoff-event",
      type: "reminder.due",
      source: "reminder",
      occurredAt: "2026-10-14T09:30:42.123Z",
      content: [{ type: "text", text: "Discuss the next steps" }],
    });
    const activeTools = getCurrentTools(requests[0]!.messages).map((tool) => tool.name);
    assert.ok(activeTools.includes("web_search"));
    assert.ok(activeTools.includes("source_check"));
    assert.ok(activeTools.includes("fetch_content"));
    const sessions = await factory.sessions.list();
    assert.equal(sessions.items.length, 1);
    const detail = await factory.sessions.get(sessions.items[0]!.id);
    assert.ok(detail);
    assert.ok(detail.items.some((item) => item.summary === "Acknowledged"));

    provider.setResponses([
      (context, _options, _state, requestModel) => {
        requests.push(context);
        sessionHeaders.push(requestModel.headers?.["x-opencode-session"]);
        return fauxAssistantMessage("- 次の会話で続ける");
      },
    ]);
    const handoff = await runtime.compactForHandoff();
    assert.match(handoff, /次の会話で続ける/);
    assert.ok(sessionHeaders[0]);
    assert.equal(sessionHeaders[1], sessionHeaders[0]);
    const summaryRequest = requests[1]!;
    const summaryPrompt = summaryRequest.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    assert.match(summaryPrompt, /Discuss the next steps/);
    assert.doesNotMatch(summaryPrompt, /Acknowledged/);
    runtime.dispose();
  } finally {
    await factory.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("resumes durable history without importing legacy Pi sessions", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-durable-legacy-session-"));
  const legacyAgentDir = join(agentDir, "legacy");
  const durableAgentDir = join(agentDir, "durable");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const sessionKey = "discord-channel:legacy-session";
  const legacySessionDir = join(legacyAgentDir, "sessions", encodeURIComponent(sessionKey));
  const legacy = SessionManager.create(process.cwd(), legacySessionDir);
  legacy.appendMessage({ role: "user", content: "Legacy-only history", timestamp: 10 });
  legacy.appendMessage(fauxAssistantMessage("Legacy-only response"));
  const options = {
    agentDir: durableAgentDir,
    configDir: legacyAgentDir,
    modelRuntime,
    sessionMode: "resume" as const,
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
  };
  let factory = createPiDurableAgentFactory(options);
  let runtime: AgentRuntime | undefined;

  try {
    runtime = await factory.create({ systemPrompt: "Test" }, [], { sessionKey });
    const firstRequests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        firstRequests.push(context);
        return fauxAssistantMessage("Durable-only response");
      },
    ]);
    await runtime.prompt({
      id: "durable-only-event",
      type: "chat.message",
      source: "test",
      occurredAt: "2026-10-29T12:00:00.000Z",
      content: [{ type: "text", text: "Durable-only history" }],
    });
    assert.doesNotMatch(JSON.stringify(firstRequests), /Legacy-only history/);
    runtime.dispose();
    runtime = undefined;
    await factory.close();

    factory = createPiDurableAgentFactory(options);
    runtime = await factory.create({ systemPrompt: "Test" }, [], { sessionKey });
    const resumedRequests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        resumedRequests.push(context);
        return fauxAssistantMessage("Resumed response");
      },
    ]);
    await runtime.prompt({
      id: "resume-durable-event",
      type: "chat.message",
      source: "test",
      occurredAt: "2026-10-29T12:01:00.000Z",
      content: [{ type: "text", text: "Continue durable history" }],
    });
    assert.match(JSON.stringify(resumedRequests), /Durable-only history/);
    assert.doesNotMatch(JSON.stringify(resumedRequests), /Legacy-only history/);
  } finally {
    runtime?.dispose();
    await factory.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("isolates channel histories and tool bindings when sessions resume or start fresh", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-durable-channels-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const options = {
    agentDir,
    modelRuntime,
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
    permissions: { tools: { overrides: { owner_note: "owner" as const } } },
  };
  let factory = createPiDurableAgentFactory({ ...options, sessionMode: "resume" });
  const runtimes: AgentRuntime[] = [];
  const discordKey = "discord-channel:shared:public";
  const webKey = "web-chat:shared:public";
  const ownerKey = "web-chat:shared:owner:123";
  const createRuntime = async (sessionKey: string, destination: string, owner = false) => {
    const runtime = await factory.create(
      { systemPrompt: `Reply in ${destination}` },
      [
        defineTool({
          name: "reply",
          description: "Reply to the current destination",
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: "text" as const, text: destination }] }),
        }),
        defineTool({
          name: "owner_note",
          description: "Read private notes",
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: "text" as const, text: "private note" }] }),
        }),
      ],
      { sessionKey, ownerFeaturesAllowed: owner },
    );
    runtimes.push(runtime);
    return runtime;
  };
  const prompt = async (runtime: AgentRuntime, text: string) => {
    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage(fauxToolCall("reply", {}), { stopReason: "toolUse" });
      },
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("Done");
      },
    ]);
    await runtime.prompt({
      id: text,
      type: "chat.message",
      source: "test",
      occurredAt: "2026-10-25T01:00:00.000Z",
      content: [{ type: "text", text }],
    });
    const result = [...requests[1]!.messages]
      .reverse()
      .find((message) => message.role === "toolResult" && message.toolName === "reply");
    assert.ok(result && result.role === "toolResult");
    return { request: requests[0]!, output: result.content };
  };
  const closeFactory = async () => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    await factory.close();
  };

  try {
    const discord = await createRuntime(discordKey, "discord destination");
    const web = await createRuntime(webKey, "web destination");
    assert.deepEqual((await prompt(discord, "discord-only-history")).output, [
      { type: "text", text: "discord destination" },
    ]);
    assert.deepEqual((await prompt(web, "web-only-history")).output, [
      { type: "text", text: "web destination" },
    ]);
    assert.deepEqual((await prompt(discord, "discord-again")).output, [
      { type: "text", text: "discord destination" },
    ]);
    const before = await factory.sessions.list();
    assert.equal(before.items.length, 2);
    const webId = before.items.find((item) => item.channelKey === webKey)!.id;
    const rebound = await createRuntime(webKey, "updated web destination");
    assert.deepEqual((await prompt(rebound, "web-rebound")).output, [
      { type: "text", text: "updated web destination" },
    ]);

    await closeFactory();
    factory = createPiDurableAgentFactory({ ...options, sessionMode: "resume" });
    const resumed = await createRuntime(webKey, "resumed web destination");
    const resumedResult = await prompt(resumed, "web-resumed");
    const userHistory = resumedResult.request.messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content))
      .join("\n");
    assert.match(userHistory, /web-only-history/);
    assert.doesNotMatch(userHistory, /discord-only-history/);
    assert.deepEqual(resumedResult.output, [{ type: "text", text: "resumed web destination" }]);
    assert.ok(
      !getCurrentTools(resumedResult.request.messages).some((tool) => tool.name === "owner_note"),
    );
    assert.equal(
      (await factory.sessions.list()).items.find((item) => item.channelKey === webKey)!.id,
      webId,
    );

    const owner = await createRuntime(ownerKey, "owner destination", true);
    const ownerResult = await prompt(owner, "owner-only-history");
    assert.ok(
      getCurrentTools(ownerResult.request.messages).some((tool) => tool.name === "owner_note"),
    );
    assert.doesNotMatch(
      JSON.stringify(ownerResult.request.messages),
      /web-only-history|discord-only-history/,
    );

    await closeFactory();
    factory = createPiDurableAgentFactory({
      ...options,
      sessionMode: "resume",
      permissions: { tools: { overrides: { owner_note: "deny" } } },
    });
    const restrictedOwner = await createRuntime(ownerKey, "restricted owner destination", true);
    const restrictedResult = await prompt(restrictedOwner, "owner-after-permission-change");
    assert.ok(
      !getCurrentTools(restrictedResult.request.messages).some(
        (tool) => tool.name === "owner_note",
      ),
    );
    assert.match(JSON.stringify(restrictedResult.request.messages), /owner-only-history/);

    await closeFactory();
    factory = createPiDurableAgentFactory({ ...options, sessionMode: "new" });
    const fresh = await createRuntime(webKey, "fresh web destination");
    const freshResult = await prompt(fresh, "web-fresh");
    assert.doesNotMatch(
      JSON.stringify(freshResult.request.messages),
      /web-only-history|owner-only-history/,
    );
    const after = await factory.sessions.list();
    assert.equal(after.items.length, 4);
    assert.equal(after.items.filter((item) => item.channelKey === webKey).length, 2);
    assert.ok(after.items.some((item) => item.id === webId));
  } finally {
    await closeFactory();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("writes assistant text to its output sink and preserves assistant messages", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-durable-assistant-text-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const factory = createPiDurableAgentFactory({
    agentDir: join(agentDir, "durable"),
    modelRuntime,
    sessionMode: "resume",
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
  });

  try {
    const deliveredText: string[] = [];
    const runtime = await factory.create(
      {
        systemPrompt: "Domain agent prompt",
      },
      [],
      {
        sessionKey: "agent:calendar",
        outputSink: {
          writeAssistantText(text) {
            deliveredText.push(text);
          },
        },
      },
    );
    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("First domain reply");
      },
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("Second domain reply");
      },
    ]);

    await runtime.prompt({
      id: "event-1",
      type: "discord.message",
      source: "discord",
      occurredAt: "2026-10-25T01:00:00.000Z",
      content: [{ type: "text", text: "What is on my schedule?" }],
    });
    assert.deepEqual(deliveredText, ["First domain reply"]);

    await runtime.prompt({
      id: "event-2",
      type: "discord.message",
      source: "discord",
      occurredAt: "2026-10-25T01:01:00.000Z",
      content: [{ type: "text", text: "And tomorrow?" }],
    });
    assert.deepEqual(deliveredText, ["First domain reply", "Second domain reply"]);

    const secondRequestText = JSON.stringify(requests[1]!.messages);
    assert.match(secondRequestText, /First domain reply/);
    assert.doesNotMatch(secondRequestText, /Remained silent\./);
    runtime.dispose();
  } finally {
    await factory.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});
