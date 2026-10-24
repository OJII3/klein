import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { createPiDurableAgentFactory } from "./pi-durable-agent-runtime";
import type { AgentRuntime } from "@agents/core/agent-runtime";

test("imports every legacy Pi session and resumes the latest durable conversation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-migration-"));
  const legacyAgentDir = join(agentDir, "legacy");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const model = provider.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const sessionKey = "discord-channel:migration";
  const legacySessionDir = join(legacyAgentDir, "sessions", encodeURIComponent(sessionKey));
  const legacy = SessionManager.create(process.cwd(), legacySessionDir);
  legacy.appendMessage({ role: "user", content: "Previous conversation", timestamp: 10 });
  legacy.appendMessage(fauxAssistantMessage("Previous reply"));
  await utimes(
    legacy.getSessionFile()!,
    new Date(Date.now() - 60_000),
    new Date(Date.now() - 60_000),
  );
  const latest = SessionManager.create(process.cwd(), legacySessionDir);
  latest.appendMessage({ role: "user", content: "Latest conversation", timestamp: 20 });
  latest.appendMessage(fauxAssistantMessage("Latest reply"));
  const factory = createPiDurableAgentFactory({
    agentDir: join(agentDir, "durable"),
    legacyAgentDir,
    modelRuntime,
    sessionMode: "resume",
    llm: { provider: model.provider, model: model.id },
    logger: pino({ level: "silent" }),
  });

  try {
    const runtime = (await factory.create(
      { systemPrompt: "Test system prompt", toolNames: [] },
      [],
      { sessionKey },
    )) as AgentRuntime & { compactForHandoff(): Promise<string> };
    const requests: TranscriptContext[] = [];
    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("Acknowledged");
      },
    ]);
    await runtime.prompt({
      id: "migration-event",
      type: "reminder.due",
      source: "reminder",
      occurredAt: "2026-10-14T09:30:42.123Z",
      content: [{ type: "text", text: "Continue from the latest conversation" }],
    });
    const activeTools = getCurrentTools(requests[0]!.messages).map((tool) => tool.name);
    assert.ok(activeTools.includes("web_search"));
    assert.ok(activeTools.includes("source_check"));
    assert.ok(activeTools.includes("fetch_content"));
    const resumedText = requests[0]!.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    assert.match(resumedText, /Latest conversation/);
    assert.doesNotMatch(resumedText, /Previous conversation/);
    const sessions = await factory.sessions.list();
    assert.equal(sessions.items.length, 2);
    const latestSession = sessions.items.find(
      (session) => session.firstMessage === "Latest conversation",
    );
    const previousSession = sessions.items.find(
      (session) => session.firstMessage === "Previous conversation",
    );
    assert.ok(latestSession);
    assert.ok(previousSession);
    const detail = await factory.sessions.get(latestSession.id);
    assert.ok(detail);
    assert.ok(detail.items.some((item) => item.summary === "Latest conversation"));
    assert.ok(detail.items.some((item) => item.summary === "Latest reply"));

    provider.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("- 次の会話で続ける");
      },
    ]);
    const handoff = await runtime.compactForHandoff();
    assert.match(handoff, /次の会話で続ける/);
    const summaryRequest = requests[1]!;
    const summaryPrompt = summaryRequest.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    assert.match(summaryPrompt, /Continue from the latest conversation/);
    assert.doesNotMatch(summaryPrompt, /Acknowledged/);
    runtime.dispose();
  } finally {
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
      { systemPrompt: `Reply in ${destination}`, toolNames: ["reply", "owner_note"] },
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
    await assert.rejects(access(join(agentDir, "pi-durable-sessions.json")), { code: "ENOENT" });

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

test("migrates session JSON and Discord state into the existing database once", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-durable-json-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const channelStateDirectory = join(agentDir, "channel-session-state");
  const indexPath = join(agentDir, "pi-durable-sessions.json");
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
    sessionMode: "resume" as const,
    legacyChannelSessionStateDirectory: channelStateDirectory,
  };
  // Seed a real pre-migration Pi conversation without the new store's migration marker.
  const storage = await openNodeSqliteStorage(join(agentDir, "pi-durable.sqlite"));
  const harness = await Harness.open(
    storage,
    { models: modelRuntime, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  await harness.close(BACKGROUND_CONTEXT);
  const sessionKey = "discord-channel:channel:owner:123:rotation:2026-10-24";
  const state = {
    channelId: "channel",
    accessScope: "owner:123",
    sessionKey,
    lastActivityAt: 1_000,
    lastRotationDate: "2026-10-24",
    hasActivitySinceRotation: false,
    handoffContext: "private handoff",
  };
  await mkdir(channelStateDirectory);
  await writeFile(indexPath, JSON.stringify({ [sessionKey]: [conversation.id] }));
  await writeFile(join(channelStateDirectory, "channel.json"), JSON.stringify(state));
  let factory = createPiDurableAgentFactory(options);
  try {
    assert.deepEqual(await factory.channelSessionStateStore.list(), [state]);
    assert.equal((await factory.sessions.list()).items[0]!.id, String(conversation.id));
    const runtime = await factory.create({ systemPrompt: "Test", toolNames: [] }, [], {
      sessionKey,
    });
    assert.equal((await factory.sessions.list()).items.length, 1);
    runtime.dispose();
    await factory.channelSessionStateStore.save({ ...state, handoffContext: undefined });
    await factory.close();
    await writeFile(indexPath, "corrupt old index");
    await writeFile(join(channelStateDirectory, "channel.json"), "corrupt old state");
    factory = createPiDurableAgentFactory(options);
    assert.equal((await factory.sessions.list()).items[0]!.id, String(conversation.id));
    assert.equal((await factory.channelSessionStateStore.list())[0]!.handoffContext, undefined);
  } finally {
    await factory.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});
